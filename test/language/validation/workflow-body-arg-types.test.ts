// M-T6.18 gap #3 — a workflow's create/handle/on/apply bodies + create/handle
// param defaults are now fed the SAME record-construction, emit-field, and
// param-default type checks the aggregate body gets (previously only aggregate
// operations were walked). A wrong-typed VO construction, emit field, or param
// default inside a workflow body compiled the .ddd and only failed the emitted
// backend.
//
// (Bare operation-call STATEMENTS in a workflow body — `o.bump(x)` — resolve
// through the aggregate-less `checkCallStmt` path a workflow doesn't have an
// aggregate for, and free-call resolution needs an env anchor a workflow body
// lacks; those arg-type sites stay a follow-on. This slice covers the FIELD
// types the task names.)

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (members: string) => `
system Demo {
  subdomain S {
    context C {
      valueobject Coin { amount: decimal  currency: string }
      event Placed { qty: int }
      aggregate Order with crudish {
        qty: int
        price: Coin
      }
      repository Orders for Order { }
      ${members}
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(members: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(members), { validate: true });
  return codesOf(diagnostics);
}
async function errorMessages(members: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(members), { validate: true });
  return diagnostics.filter((d) => d.severity === 1).map((d) => d.message);
}

const CONSTRUCTION = "loom.construction-field-type";

describe("workflow body construction/emit/param-default types (M-T6.18 gap #3)", () => {
  it("flags a wrong-typed VO-construction field in a `create` body", async () => {
    expect(
      await codes(`workflow W {
        create(label: string) { let m = Coin { amount: "oops", currency: "USD" } }
      }`),
    ).toContain(CONSTRUCTION);
  });

  it("is CLEAN for a well-typed VO-construction field in a `create` body", async () => {
    expect(
      await codes(`workflow W {
        create(label: string) { let m = Coin { amount: 5.0, currency: "USD" } }
      }`),
    ).not.toContain(CONSTRUCTION);
  });

  it("flags a wrong-typed emit field in a `create` body", async () => {
    const errs = await errorMessages(`workflow W {
      create(label: string) { emit Placed { qty: "abc" } }
    }`);
    expect(errs.some((m) => /Field 'qty'.*expects 'int'.*got 'string'/.test(m))).toBe(true);
  });

  it("flags a wrong-typed emit field NESTED in a `create` body block", async () => {
    // Nested inside a `for`, exercising the stream-based emit search rather
    // than a scan of the body's top-level statements.  (`for` and `if let` are
    // the block statements a workflow body has today — there is no plain
    // `if <cond> { … }` statement in the grammar, so a fixture written with
    // one never parsed and this test was reading a recovery fragment.)
    const errs = await errorMessages(`workflow W {
      items: int[]
      create(label: string) {
        for n in items { emit Placed { qty: "abc" } }
      }
    }`);
    expect(errs.some((m) => /Field 'qty'.*expects 'int'.*got 'string'/.test(m))).toBe(true);
  });

  it("flags a wrong-typed param default on a `create` trigger", async () => {
    const errs = await errorMessages(`workflow W { create(threshold: int = "x") { } }`);
    expect(errs.some((m) => /[Dd]efault for parameter 'threshold'/.test(m))).toBe(true);
  });

  it("is CLEAN for a well-typed workflow body", async () => {
    const c = await codes(`workflow W {
      create(label: string) {
        let m = Coin { amount: 1.0, currency: "USD" }
        emit Placed { qty: 3 }
      }
    }`);
    expect(c).not.toContain(CONSTRUCTION);
    expect(c.filter((x) => x.startsWith("loom.")).length).toBe(0);
  });
});
