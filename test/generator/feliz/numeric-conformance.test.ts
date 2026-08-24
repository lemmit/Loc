// Feliz numeric conformance (M-T1.22, audit F2) — the arms where F#'s numeric
// semantics diverge from Loom's and the divergence is invisible to the
// compile-only `generated-feliz-build` gate:
//
//   • `a / b` on two integers.  Loom's type system WIDENS integer division to
//     `decimal` (`5 / 2` is `2.5`) — every other target honours that through
//     the shared `isIntDivWidenedToDecimal` predicate.  F# is in the truncating
//     family, so without the widening arm a page body silently computed `2`.
//   • `long`.  It collapsed to F# `int` (+ `Decode.int`), so anything past
//     int32 was rejected by the record decoder — a runtime failure the Fable
//     compile cannot see.
//   • bad numeric TEXT in a number input.  Every form cell is a `string`; the
//     encoder converts with F#'s `int`/`decimal`, which PARSE and THROW.  A
//     `type=number` input happily holds `"2.5"` in an `int` field, so submit
//     threw an unhandled Elmish exception instead of showing a form error.
//
// Both feliz expression paths are asserted for the division: the VIEW path
// (shared `_walker/walker-core.ts` → the `exprIntDivWidened` seam) and the MVU
// UPDATE path (`fs-expr.ts`'s own dispatcher). They share one function, and
// this pins that they cannot drift apart.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const sys = (body: string) => `
system P {
  subdomain S { context C {
    aggregate Order { name: string }
    repository Orders for Order { }
  } }
  api A from S
  ui WebApp {
    api C: A
    ${body}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { C: api } port: 3005 }
}`;

/** Generate `src/App.fs` for a feliz-hosted ui with this ui body. */
async function app(body: string): Promise<string> {
  const model = await buildLoomModel(sys(body));
  const s = model.systems[0]!;
  const web = s.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
}

describe("feliz: integer division widens to decimal", () => {
  it("widens both operands on the MVU update path", async () => {
    const fs = await app(`
    page Calc {
      route: "/calc"
      state { hits: int = 5  visits: int = 2  rate: decimal = 0 }
      action compute() { rate := hits / visits }
      body: Button("go", onClick: compute)
    }`);
    // Both operands converted — F#'s `int / int` truncates, and `decimal l / r`
    // with an `int` right-hand side does not even typecheck.
    expect(fs).toContain("((decimal model.Hits) / (decimal model.Visits))");
    // The un-widened form must not survive anywhere.
    expect(fs).not.toContain("(model.Hits / model.Visits)");
  });

  // A body-position division goes through the SHARED walker
  // (`_walker/walker-core.ts`), not `fs-expr.ts`'s own dispatcher — so it only
  // reaches the F# arm through the new `WalkerTarget.exprIntDivWidened` seam.
  it("widens both operands on the view path (the walker seam)", async () => {
    const fs = await app(`
    page Calc {
      route: "/calc"
      state { hits: int = 5  visits: int = 2 }
      body: Text { \`Rate: {hits / visits}\` }
    }`);
    expect(fs).toContain("((decimal model.Hits) / (decimal model.Visits))");
    expect(fs).not.toContain("(model.Hits / model.Visits)");
  });

  it("leaves a mixed int / decimal division alone", async () => {
    const fs = await app(`
    page Calc {
      route: "/calc"
      state { total: decimal = 10  parts: int = 4  rate: decimal = 0 }
      action compute() { rate := total / parts }
      body: Button("go", onClick: compute)
    }`);
    // The shared predicate refuses a mixed operand pair — its decimal side is
    // already fractional and must not be re-wrapped.
    expect(fs).toContain("(model.Total / model.Parts)");
    expect(fs).not.toContain("(decimal model.Total)");
  });
});
