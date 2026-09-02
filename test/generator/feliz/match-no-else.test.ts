// Feliz MVU update path — a value-position `match { … }` with NO `else` arm.
//
// `match` used as a VALUE is expected to cover its domain, so the `else` is
// optional in the grammar and the validator only WARNS about a missing one.
// The shared view walker degrades gracefully: with no `else` it promotes the
// LAST arm's value to the tail of the right-fold (`_walker/walker-core.ts`), so
// every other frontend emits.  `fs-expr.ts` — the SECOND expression dispatcher,
// used on the MVU `update`/`init` path — instead THREW, so
// `action go() { label := match { n > 1 => "big" } }` crashed `ddd generate
// system` outright.  This pins the same promotion on the feliz update path, so
// both feliz paths and the other five frontends agree on what a no-`else` match
// means.

import { describe, expect, it } from "vitest";
import { renderFsExpr } from "../../../src/generator/feliz/fs-expr.js";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SYS = `
system P {
  subdomain S { context C { } }
  ui WebApp {
    page Home {
      route: "/"
      state { n: int = 0  label: string = ""  size: string = "" }
      // No \`else\` arm — the last arm is the fallback.
      action classify() { label := match { n > 10 => "big"  n > 5 => "mid" } }
      // Degenerate single-arm form: the whole match IS its fallback.
      action only() { size := match { n > 0 => "some" } }
      body: Stack { Heading { "H", level: 1 }, Button { "b", onClick: classify } }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}`;

async function app(): Promise<string> {
  const model = await buildLoomModel(SYS);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], sys, web).get("src/App.fs")!;
}

describe("feliz value-position `match` with no `else`", () => {
  it("promotes the last arm to the F# `else` tail instead of crashing codegen", async () => {
    const fs = await app();
    // `n > 5 => "mid"` becomes the tail — its condition is dropped, exactly as
    // walker-core's right-fold drops it on the view path.
    expect(fs).toContain('{ model with Label = (if (model.N > 10) then "big" else "mid") }');
  });

  it("a single-arm no-`else` match renders as its bare value", async () => {
    const fs = await app();
    expect(fs).toContain('{ model with Size = ("some") }');
  });

  it("renderFsExpr folds a no-`else` match directly", () => {
    const match: ExprIR = {
      kind: "match",
      arms: [
        {
          cond: { kind: "ref", name: "a", refKind: "let" },
          value: { kind: "literal", lit: "int", value: 1 },
        },
        {
          cond: { kind: "ref", name: "b", refKind: "let" },
          value: { kind: "literal", lit: "int", value: 2 },
        },
      ],
    } as ExprIR;
    expect(renderFsExpr(match, { stateNames: new Set(), locals: new Set(["a", "b"]) })).toBe(
      "(if a then 1 else 2)",
    );
  });

  it("a match with neither arms nor an `else` still fails fast", () => {
    const empty = { kind: "match", arms: [] } as unknown as ExprIR;
    expect(() => renderFsExpr(empty, { stateNames: new Set(), locals: new Set() })).toThrow(
      /no value to render/,
    );
  });
});
