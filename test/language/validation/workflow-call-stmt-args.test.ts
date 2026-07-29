// `loom.call-arg-count` / `loom.call-arg-type` for bare operation/function-call
// STATEMENTS in a workflow body (`o.bump(x)`) — the follow-on to #2238 that the
// workflow-body receiver-typing enhancement unlocks. A bare call statement is an
// AssignOrCallStmt LValue (not a PostfixChain), so #2238's `checkExprCallArgs`
// never saw it, and `checkCallStmt` only runs for aggregate operations (a
// workflow has no `this`). The receiver is resolved through the body's typed
// lets, which now type both load forms: a factory `Agg.create({…})` and a
// repository read (`Repo.getById`/`findById`, `findAll`/`all`, or a declared
// `find`). A write / unrecognised repository method stays untyped, so the check
// fails open there rather than false-positiving.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (body: string) => `
system Demo {
  subdomain S {
    context C {
      valueobject Coin { amount: decimal  currency: string  function scaled(f: int): decimal = amount * f }
      aggregate Order with crudish {
        qty: int
        operation bump(n: int) { qty := qty + n }
      }
      repository Orders for Order { }
      workflow W { create(label: string) { ${body} } }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

// Variant with declared finds injected into the repository.
const sysWith = (finds: string, body: string) => `
system Demo {
  subdomain S {
    context C {
      aggregate Order with crudish {
        qty: int
        operation bump(n: int) { qty := qty + n }
      }
      repository Orders for Order { ${finds} }
      workflow W { create(label: string) { ${body} } }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(body: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(body), { validate: true });
  return codesOf(diagnostics);
}

const COUNT = "loom.call-arg-count";
const TYPE = "loom.call-arg-type";

describe("workflow-body operation-call statement args (M-T6.18 gap #3 follow-on)", () => {
  it("flags a wrong-typed operation-call arg on a factory-loaded receiver", async () => {
    expect(await codes('let o = Order.create({ qty: 1 })  o.bump("x")')).toContain(TYPE);
  });

  it("flags a wrong-arity operation-call on a factory-loaded receiver", async () => {
    expect(await codes("let o = Order.create({ qty: 1 })  o.bump()")).toContain(COUNT);
  });

  it("is CLEAN for a correctly-typed operation-call", async () => {
    const c = await codes("let o = Order.create({ qty: 1 })  o.bump(3)");
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });

  it("flags a wrong-typed function-call arg on a VO-typed receiver", async () => {
    expect(await codes('let m = Coin { amount: 1.0, currency: "USD" }  m.scaled("x")')).toContain(
      TYPE,
    );
  });

  it("is CLEAN for a correctly-typed VO function-call", async () => {
    expect(await codes('let m = Coin { amount: 1.0, currency: "USD" }  m.scaled(3)')).not.toContain(
      TYPE,
    );
  });

  it("flags a wrong-typed operation-call arg on a repository (getById) loaded receiver", async () => {
    expect(await codes('let o = Orders.getById("id")  o.bump("x")')).toContain(TYPE);
  });

  it("flags a wrong-arity operation-call on a findById-loaded receiver", async () => {
    expect(await codes('let o = Orders.findById("id")  o.bump()')).toContain(COUNT);
  });

  it("is CLEAN for a correctly-typed operation-call on a repository-loaded receiver", async () => {
    const c = await codes('let o = Orders.getById("id")  o.bump(3)');
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });

  it("flags a wrong-typed operation-call on a declared-find-loaded receiver", async () => {
    // A declared `find mine(): Order` yields its return type (single Order).
    const src = sysWith("find mine(): Order", 'let o = Orders.mine()  o.bump("x")');
    const { diagnostics } = await parseString(src, { validate: true });
    expect(codesOf(diagnostics)).toContain(TYPE);
  });

  it("fails open on a WRITE repository method (untyped receiver)", async () => {
    // `Orders.save(...)` is a write, not a read — it yields no receiver type, so
    // the check stays silent rather than mis-flagging.
    const c = await codes('let o = Orders.save("id")  o.bump("x")');
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });
});
