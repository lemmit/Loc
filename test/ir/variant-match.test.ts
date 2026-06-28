// Variant-`match` (variant-match.md) — parsing + IR-validation pins.
//
// A scrutinee-bearing `match SUBJECT { Variant binding => expr }` discriminates
// an `or`-union value.  These cover the happy path (parses, lowers, no
// match-diagnostics) and the load-bearing negative gate (a non-union subject).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (consumer: string) => `
  system Shop {
    subdomain Sales {
      context Shop {
        error NF { detail: string }
        aggregate A ids guid {
          code: string
          operation reserve(): A or NF { return NF { detail: code } }
          ${consumer}
        }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource shopState { for: Shop, kind: state, use: pg }
    deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
  }
`;

const matchCodes = async (src: string): Promise<string[]> => {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.code?.startsWith("loom.match-"))
    .map((d) => d.code as string);
};

describe("variant-match", () => {
  it("parses and validates a variant-match over an or-union (no diagnostics)", async () => {
    const src = SYS(`
      operation summarize(): string {
        let o = reserve()
        return match o { A a => a.code, NF n => n.detail }
      }`);
    const { diagnostics } = await parseString(src, { validate: true });
    expect(diagnostics.filter((d) => d.severity === 1)).toHaveLength(0); // no parse/validate errors
    expect(await matchCodes(src)).toEqual([]);
  });

  it("keeps the binding's narrowed type so a field read resolves", async () => {
    const src = SYS(`
      operation summarize(): string {
        let o = reserve()
        return match o { A a => a.code, NF n => n.detail }
      }`);
    const { model } = await parseString(src, { validate: false });
    const loom = enrichLoomModel(lowerModel(model));
    // Walk to the `match` node and confirm the error variant is flagged.
    const op = allContexts(loom)[0]!.aggregates[0]!.operations.find((o) => o.name === "summarize")!;
    const ret = op.statements.find((s) => s.kind === "return")!;
    const m = ret.kind === "return" ? ret.value : undefined;
    expect(m?.kind).toBe("match");
    if (m?.kind !== "match") throw new Error("expected match");
    expect(m.variantArms.map((a) => a.isError)).toEqual([false, true]);
  });

  it("errors (loom.match-non-union-subject) when the scrutinee is not a union", async () => {
    const src = SYS(`
      operation bad(): string {
        let s = code
        return match s { A a => a.code }
      }`);
    expect(await matchCodes(src)).toContain("loom.match-non-union-subject");
  });
});
