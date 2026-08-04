// Collection ops inside a `test e2e` body.
//
// The e2e renderer lowers against the WIRE — parsed JSON off a real response —
// not against the domain object graph, so it needs its own collection-op table
// rather than the domain one (`TS_COLLECTION_RENDERERS`).  The two differ on
// exactly one axis, but it is a load-bearing one: the domain represents `money`
// as a decimal.js `Decimal`, and the emitted e2e suite imports nothing but
// vitest, so a `Decimal` reference there is a `ReferenceError` rather than a
// wrong number.
//
// Before this table existed the `method-call` arm fell through to a verbatim
// `${recv}.${member}(...)`, so `trail.first()` emitted `trail.first()` — and JS
// arrays have no `.first`.  The suite compiled, ran, and died with a TypeError
// at the assertion.  That silent-fallthrough shape is what the completeness pin
// below exists to prevent.

import { describe, expect, it } from "vitest";
import { E2E_COLLECTION_RENDERERS } from "../../src/system/e2e-render.js";
import { COLLECTION_OP_SIGNATURES } from "../../src/util/collection-ops.js";
import { generateSystemFiles } from "../_helpers/generate.js";

const SRC = `system S {
  subdomain M {
    context C {
      aggregate Order {
        reference: string
        quantity: int
        create(reference: string, quantity: int) {
          reference := reference
          quantity := quantity
        }
        operation bump(n: int) { quantity := quantity + n }
      }
      repository Orders for Order {
        find byReference(reference: string): Order? where this.reference == reference
      }
    }
  }
  api A from M
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable d {
    platform: node
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }

  test e2e "collection ops lower to real JS" against d {
    let a = api.orders.create({ reference: "R1", quantity: 2 })
    let all = api.orders.all()
    expect(all.items.count).toBe(1)
    expect(all.items.first().reference).toBe("R1")
    expect(all.items.map(o => o.quantity).sum()).toBe(2)
    expect(all.items.where(o => o.quantity > 1).count).toBe(1)
    expect(all.items.any(o => o.reference == "R1")).toBe(true)
    expect(all.items.sortBy(o => o.quantity).first().reference).toBe("R1")
  }
}`;

async function e2eFile(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) if (p.endsWith(".e2e.test.ts")) return c;
  throw new Error(`no e2e file; have ${[...files.keys()].join(", ")}`);
}

describe("e2e collection ops — completeness", () => {
  it("every catalogue op has a wire renderer", () => {
    // Adding an op to the catalogue must force a wire-vs-domain decision here.
    // Without this pin the new op silently falls through to `.op(...)`, which
    // compiles and then throws at run time.
    const missing = COLLECTION_OP_SIGNATURES.map((o) => o.name).filter(
      (n) => !(n in E2E_COLLECTION_RENDERERS),
    );
    expect(missing).toEqual([]);
  });

  it("carries no renderer the catalogue does not declare", () => {
    const names = new Set(COLLECTION_OP_SIGNATURES.map((o) => o.name));
    expect(Object.keys(E2E_COLLECTION_RENDERERS).filter((k) => !names.has(k))).toEqual([]);
  });
});

describe("e2e collection ops — emission", () => {
  it("lowers call-style ops to real array operations, not verbatim method calls", async () => {
    const f = await e2eFile();
    // The regression: `.first()` is not a JS array method.
    expect(f).not.toContain(".first()");
    expect(f).not.toContain(".sortBy(");
    expect(f).toContain("[0]");
    expect(f).toContain(".reduce(");
    expect(f).toContain(".filter(");
    expect(f).toContain(".some(");
    expect(f).toContain("].sort(");
  });

  it("dispatches property-style `count` at run time, where the type actually is", async () => {
    const f = await e2eFile();
    // `x.count` lowers to a MEMBER node with no collection-op marker, and a test
    // body is placeholder-typed — so it is ambiguous between the op and a field
    // named `count`.  Guessing either way at emit time is wrong for the other
    // case; the runtime value knows.
    expect(f).toContain("__count(");
    expect(f).not.toMatch(/\.count\)/);
  });

  it("emits the wire comparison helpers the ordering ops call", async () => {
    const f = await e2eFile();
    expect(f).toContain("function __cmpKey(");
    expect(f).toContain("function __num(");
    // `sortBy` compares through `__cmpKey` so a money/decimal STRING orders
    // numerically — plain `<` would put "10.0000" before "9.0000".
    expect(f).toContain("__cmpKey(");
  });

  it("never references decimal.js — the emitted suite imports only vitest", async () => {
    const f = await e2eFile();
    // The domain table folds money with `new Decimal(0)` / `.plus`; on the wire
    // that identifier does not exist, so this is a ReferenceError, not a bad
    // value.  Same reason the `convert`-to-money arm stopped emitting it.
    expect(f).not.toContain("Decimal");
  });
});
