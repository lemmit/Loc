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

describe("feliz: a Loom `long` is an F# int64", () => {
  const LONG_SYS = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  impressions: long }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Products {
      route: "/products"
      body: QueryView {
        of: Shop.Product.all,
        loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
        data: rows => Stack { For { each: rows, p => Card { p.name } } }
      }
    }
    page ProductNew {
      route: "/products/new"
      body: Stack { CreateForm { of: Product } }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}`;

  /** `src/App.fs` for a system source (rather than a bare ui body). */
  async function appOf(source: string): Promise<string> {
    const model = await buildLoomModel(source);
    const s = model.systems[0]!;
    const web = s.deployables.find((d) => d.name === "web")!;
    return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
  }

  it("spells the wire record field int64 and decodes it with Decode.int64", async () => {
    const fs = await appOf(LONG_SYS);
    expect(fs).toContain("impressions: int64");
    // `Decode.int` bounds-checks against Int32 and fails the WHOLE record
    // decode past 2^31 — the exact range a `long` exists to carry.
    expect(fs).toContain('get.Required.Field "impressions" Decode.int64');
  });

  it("encodes a long form field as a JSON number, not Encode.int64's string", async () => {
    const fs = await appOf(LONG_SYS);
    // Thoth's `Encode.int64` renders `value.ToString(InvariantCulture)` — a
    // JSON STRING — so the int64 goes out through `Encode.float`.
    expect(fs).toContain('"impressions", Encode.float (float (int64 form.impressions))');
    expect(fs).not.toContain('"impressions", Encode.int (int form.impressions)');
  });

  it("spells a long state cell int64, zeroes it 0L, and parses input via Int64", async () => {
    const fs = await app(`
    page Counter {
      route: "/counter"
      state { impressions: long }
      body: Stack {
        NumberField { "Impressions", bind: impressions },
        Text { \`{impressions}\` }
      }
    }`);
    expect(fs).toContain("Impressions: int64");
    expect(fs).toContain("Impressions = 0L");
    expect(fs).toContain(
      "| SetImpressions v -> { model with Impressions = (match System.Int64.TryParse v with | true, n -> n | _ -> 0L) }, Cmd.none",
    );
    expect(fs).not.toContain("System.Int32.TryParse v");
  });

  // Lowering PROMOTES a bare int literal to `long` when it meets a long
  // operand, so the literal leaf must emit the `L` suffix — a bare `3` is an
  // F# `int`, and `int64 > int` does not typecheck.
  it("suffixes a promoted long literal with L", async () => {
    const fs = await app(`
    page Counter {
      route: "/counter"
      state { impressions: long  hot: bool = false }
      action evaluate() { hot := impressions > 3 }
      body: Button("go", onClick: evaluate)
    }`);
    expect(fs).toContain("(model.Impressions > 3L)");
  });

  // A `long(x)` conversion must widen to int64, not truncate through `int`.
  it("converts to int64, never through int", async () => {
    const fs = await app(`
    page Counter {
      route: "/counter"
      state { small: int = 0  impressions: long }
      action widen() { impressions := long(small) }
      body: Button("go", onClick: widen)
    }`);
    expect(fs).toContain("(int64 model.Small)");
    expect(fs).not.toContain("(int model.Small)");
  });

  // A PERSISTED store field of type `long` crosses the JS boundary as a raw
  // string; its codec has to parse through Int64 or the parsed `int` will not
  // typecheck against the `int64` Model field (`feliz-persist-codec.ts`).
  it("persists a long store field through Int64.TryParse", async () => {
    const fs = await app(`
    store Stats persist: local {
      state { impressions: long }
      action bump() { impressions := impressions + 1 }
    }
    page Home {
      route: "/"
      body: Text { \`{Stats.impressions}\` }
    }`);
    expect(fs).toContain("StatsImpressions: int64");
    expect(fs).toContain("System.Int64.TryParse raw");
  });
});
