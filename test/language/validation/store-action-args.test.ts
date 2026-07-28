// `loom.call-arg-count` / `loom.call-arg-type` for STORE-ACTION calls
// (`Cart.add(42)`) — M-T6.18 gap #3. Page / component / store `action` bodies
// are never fed to the aggregate statement walk, so a store-action call had
// NEITHER its arity NOR its argument types checked; a wrong count or a `string`
// into an `int` action param compiled the .ddd and only failed the emitted
// frontend. `checkStoreActionCallArgs` resolves `<store>.<action>` and checks
// both invocation forms under the call site's env.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (buy: string) => `
system Demo {
  subdomain S { context C { aggregate Order with crudish { qty: int } } }
  ui Shop {
    store Cart {
      state { count: int }
      action add(qty: int) { count := count + qty }
      action reset() { count := 0 }
    }
    page Product {
      route: "/p"
      action buy() { ${buy} }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
  deployable web { platform: static targets: api ui: Shop port: 3001 }
}`;

async function codes(buy: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(buy), { validate: true });
  return codesOf(diagnostics);
}

const COUNT = "loom.call-arg-count";
const TYPE = "loom.call-arg-type";

describe("store-action call args (M-T6.18 gap #3)", () => {
  it("flags a wrong-typed store-action argument", async () => {
    expect(await codes('Cart.add("lots")')).toContain(TYPE);
  });

  it("flags a wrong-arity store-action call (too few)", async () => {
    expect(await codes("Cart.add()")).toContain(COUNT);
  });

  it("flags a wrong-arity store-action call (too many)", async () => {
    expect(await codes("Cart.reset(5)")).toContain(COUNT);
  });

  it("is CLEAN for a correctly-typed store-action call", async () => {
    const c = await codes("Cart.add(5)");
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });

  it("is CLEAN for a correct zero-arg store-action call", async () => {
    expect(await codes("Cart.reset()")).not.toContain(COUNT);
  });

  it("does not touch a non-store dotted call (`Order.create({…})`)", async () => {
    // `Order` is an aggregate, not a store — resolveStoreAction returns undefined,
    // so no store-action diagnostic (the aggregate factory has its own gates).
    const c = await codes("Cart.add(5)  let o = Order.create({ qty: 1 })");
    expect(c).not.toContain(TYPE);
    expect(c).not.toContain(COUNT);
  });
});
