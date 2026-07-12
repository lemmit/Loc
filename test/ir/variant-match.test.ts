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
        aggregate A {
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

  it("stamps subjectShape: 'absence' on a match over a union-FIND result and aliases bindings to the subject", async () => {
    // A repository union find is validator-constrained to the absence shape
    // (payloads.md §Union finds): its runtime value is the bare
    // aggregate-or-absent, never the tagged wire.  The match over it must
    // carry the stamp, and the success binding must lower to a ref to the
    // SUBJECT (narrowed to the variant), not a match-binding ref.
    const src = `
      system Shop {
        subdomain Sales {
          context Shop {
            error NF { detail: string }
            aggregate A {
              code: string
            }
            repository As for A {
              find locate(code: string): A or NF where this.code == code
            }
            workflow resolve {
              create(code: string) {
                let outcome = As.locate(code)
                let label = match outcome { A a => a.code, NF => "missing" }
              }
            }
          }
        }
        api SalesApi from Sales
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }
    `;
    const { model } = await parseString(src, { validate: false });
    const loom = enrichLoomModel(lowerModel(model));
    const wf = allContexts(loom)[0]!.workflows.find((w) => w.name === "resolve")!;
    const letStmt = wf.statements.find((s) => s.kind === "expr-let" && s.name === "label")!;
    const m = letStmt.kind === "expr-let" ? letStmt.expr : undefined;
    expect(m?.kind).toBe("match");
    if (m?.kind !== "match") throw new Error("expected match");
    expect(m.subjectShape).toBe("absence");
    // The `a.code` read lowered against the subject local, typed at A.
    const success = m.variantArms.find((a) => !a.isError)!;
    expect(success.value).toMatchObject({
      kind: "member",
      member: "code",
      receiver: {
        kind: "ref",
        name: "outcome",
        refKind: "let",
        type: { kind: "entity", name: "A" },
      },
    });
    // No match-diagnostics on the happy path.
    expect(
      validateLoomModel(loom)
        .filter((d) => d.code?.startsWith("loom.match-"))
        .map((d) => d.code),
    ).toEqual([]);
  });

  it("does NOT stamp subjectShape on a match over an operation-return union (tagged carrier)", async () => {
    const src = SYS(`
      operation summarize(): string {
        let o = reserve()
        return match o { A a => a.code, NF n => n.detail }
      }`);
    const { model } = await parseString(src, { validate: false });
    const loom = enrichLoomModel(lowerModel(model));
    const op = allContexts(loom)[0]!.aggregates[0]!.operations.find((o) => o.name === "summarize")!;
    const ret = op.statements.find((s) => s.kind === "return")!;
    const m = ret.kind === "return" ? ret.value : undefined;
    if (m?.kind !== "match") throw new Error("expected match");
    expect(m.subjectShape).toBeUndefined();
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
