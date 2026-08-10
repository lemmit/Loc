// A bare name in a `test e2e` body that binds to nothing.
//
// `lower-expr.ts` deliberately does not resolve context-scoped names inside an
// e2e body — one body may drive several contexts, so there is no single `ctx`
// to resolve against — and the e2e renderer emits bare names VERBATIM.  That is
// right for a `let` local and silently wrong for anything else: an enum value
// in an api-call payload lowered to `refKind: "unknown"` and emitted
// `{ status: Placed }`, an undefined identifier.  Valid `.ddd` in, uncompilable
// TypeScript out, with no diagnostic in between.
//
// An e2e test speaks WIRE — it POSTs JSON and reads JSON back — so the fix is
// the serialized string, and the message says so.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const SOURCE = (body: string): string => `
system Shop {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Placed }
      aggregate Order with crudish {
        code: string
        status: Status
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }

  test e2e "t" against d {
${body}
  }
}
`;

async function codesFor(body: string): Promise<string[]> {
  const diags = validateLoomModel(await buildLoomModel(SOURCE(body)));
  return diags.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("validator — e2e unresolved ref", () => {
  it("rejects an enum value spelled as a bare domain name", async () => {
    const codes = await codesFor(`
    let o = api.orders.create({ code: "C1", status: "Draft" })
    api.orders.update(o, { code: "C2", status: Placed })
  `);
    expect(codes).toContain("loom.e2e-unresolved-ref");
  });

  it("names the offending identifier and the wire form to use instead", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        SOURCE(`
    let o = api.orders.create({ code: "C1", status: "Draft" })
    api.orders.update(o, { code: "C2", status: Placed })
  `),
      ),
    );
    const d = diags.find((x) => x.code === "loom.e2e-unresolved-ref");
    expect(d?.message).toContain("'Placed'");
    // The remedy has to be IN the message — an author who reaches this has
    // just written the form that reads most naturally.
    expect(d?.message).toContain('"Placed"');
  });

  it("accepts the wire string, `let` bindings, and the magic receivers", async () => {
    const codes = await codesFor(`
    let o = api.orders.create({ code: "C1", status: "Draft" })
    api.orders.update(o, { code: "C2", status: "Placed" })
    let read = api.orders.getById(o)
    expect(read.status).toBe("Placed")
  `);
    expect(codes).not.toContain("loom.e2e-unresolved-ref");
  });

  // The CALL twin of the same hole.  A name APPLIED to arguments lowers to a
  // `callKind: "free"` Call, never a `ref`, so the bare-name gate above did not
  // see it — and the renderer emits a call verbatim too.  `expect(number(
  // t.revenue)).toBe(40)` therefore shipped `number(...)` into the generated
  // suite: a ReferenceError at run time, from valid `.ddd`, found while writing
  // projection-aggregation's first runtime caller.
  it("rejects a call to a function that resolves to nothing", async () => {
    const codes = await codesFor(`
    let o = api.orders.create({ code: "C1", status: "Draft" })
    expect(number(o.code)).toBe(1)
  `);
    expect(codes).toContain("loom.e2e-unresolved-call");
  });

  it("names the offending call and points at the built-in conversions", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        SOURCE(`
    let o = api.orders.create({ code: "C1", status: "Draft" })
    expect(number(o.code)).toBe(1)
  `),
      ),
    );
    const d = diags.find((x) => x.code === "loom.e2e-unresolved-call");
    expect(d?.message).toContain("'number(…)'");
    expect(d?.message).toContain("decimal(…)");
  });

  it("accepts the built-in conversions and collection ops", async () => {
    // These lower to `convert` / `method-call` nodes, not to a free call — the
    // gate must not reach them, or every money/decimal assertion breaks.
    const codes = await codesFor(`
    let o = api.orders.create({ code: "C1", status: "Draft" })
    let all = api.orders.all()
    expect(string(o.code)).toBe("C1")
    expect(all.items.count()).toBe(1)
  `);
    expect(codes).not.toContain("loom.e2e-unresolved-call");
  });

  it("accepts an api-shaped body aimed at a UI-mounting deployable", async () => {
    // A test's kind comes from the TARGET DEPLOYABLE's platform, not from what
    // the body spells, so this classifies as `ui` while correctly spelling
    // `api`.  Binding only the classified magic id rejected every such test and
    // took out the whole behavioral Phoenix leg at generate time — caught by
    // running that leg, not by any assertion.
    const src = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { code: string }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: elixir contexts: [Orders] dataSources: [st] port: 4000 }

  test e2e "t" against d {
    let o = api.orders.create({ code: "C1" })
    let read = api.orders.getById(o)
    expect(read.code).toBe("C1")
  }
}
`;
    const codes = validateLoomModel(await buildLoomModel(src))
      .filter((d) => d.severity === "error")
      .map((d) => d.code);
    expect(codes).not.toContain("loom.e2e-unresolved-ref");
  });
});
