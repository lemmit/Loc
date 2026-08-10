// What a lifecycle `requires` may READ — the contract that makes route-level
// gating of a canonical `create` / `destroy` possible at all.
//
// This exists because the first attempt at gating ASSUMED the contract and
// shipped a regression on the strength of it.  `create() { requires quantity
// == 0 }` parses, lowers to a `this-prop` ref, and emits an unbound receiver on
// every backend — `this._quantity` inside a module-scope handler (Hono),
// `cannot find symbol` (Java), CS1061 (.NET), `F821 Undefined name self`
// (Python), an undefined `record` (Elixir).  Four non-compiling projects out of
// source that parsed clean, which is strictly worse than the silent drop the
// work set out to fix.
//
// The lesson, and the reason this file is a peer of the emission rather than a
// footnote in it: a contract nothing enforces is a comment.  The emission may
// only assume what a check has already made true.
//
// The two actions differ, and the difference is not cosmetic:
//   create  — `currentUser` only.  No instance exists until the factory runs,
//             and the emitted POST takes the FIELD-DERIVED create input rather
//             than the declared parameter list, so a `param` ref has no wire
//             slot to be read from either.
//   destroy — `currentUser` plus `this`, because the route already loads the
//             row for its 404 probe.  `param` stays out: a DELETE has no body.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const CODE = "loom.lifecycle-guard-unreadable";

const wrap = (agg: string): string => `
system P {
  user { id: string  role: string }
  subdomain D {
    context Orders {
${agg}
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}`;

async function codesFor(agg: string): Promise<string[]> {
  const diags = validateLoomModel(await buildLoomModel(wrap(agg)));
  return diags.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("a lifecycle `requires` may only read what the gate can see", () => {
  it("rejects a CREATE guard reading a field — the regression this check exists for", async () => {
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string) { requires quantity == 0 }
      }`),
    ).toContain(CODE);
  });

  it("rejects a CREATE guard reading a declared parameter", async () => {
    // The parameter list never reaches the wire — the create input is derived
    // from the FIELD set — so there is nowhere to read the value from.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        create(code: string, qty: int) { requires currentUser.role == "admin" && qty > 0 }
      }`),
    ).toContain(CODE);
  });

  it("rejects a DESTROY guard reading a parameter — a DELETE carries no body", async () => {
    // `destroy` was skipped entirely on the reasoning that it takes no
    // parameters.  The grammar accepts them, so the reasoning was not a check.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        destroy(reason: string) { requires reason.length > 0 }
      }`),
    ).toContain(CODE);
  });

  it("names the offending ref rather than gesturing at the clause", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        wrap(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string) { requires quantity == 0 }
      }`),
      ),
    );
    expect(diags.find((d) => d.code === CODE)?.message).toMatch(/`quantity`/);
  });

  it("accepts a principal-only CREATE guard", async () => {
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        create(code: string) { requires currentUser.role == "admin" }
      }`),
    ).not.toContain(CODE);
  });

  it("accepts a DESTROY guard reading `this` alongside the principal", async () => {
    // The half that must NOT be rejected: the route loads the row before the
    // gate, so a state precondition on deletion is legitimate — and it is what
    // makes 404-before-403 observable.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        destroy { requires currentUser.role == "admin" && quantity == 0 }
      }`),
    ).not.toContain(CODE);
  });
});
