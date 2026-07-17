// `loom.construction-field-type` (M-T6.18 slice 2) — a record built with
// `X { field: value }` in an operation / create / destroy body must supply a
// value whose type is assignable to the declared field type.  The value-type
// twin of `loom.unknown-construction-field` (name check); this one needs the
// lexical env, so it rides the statement walk.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (body: string) => `
system Demo {
  subdomain S {
    context C {
      valueobject Coin { amount: decimal  currency: string }
      aggregate Order with crudish {
        price: Coin
        qty: int
        ${body}
      }
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

const CODE = "loom.construction-field-type";

describe("loom.construction-field-type (M-T6.18 slice 2)", () => {
  it("rejects a string value in a decimal field", async () => {
    expect(
      await codes('operation setp() { price := Coin { amount: "oops", currency: "USD" } }'),
    ).toContain(CODE);
  });

  it("rejects a string value in a string field's sibling numeric field (currency ok, amount bad)", async () => {
    expect(
      await codes('operation setp() { price := Coin { amount: true, currency: "USD" } }'),
    ).toContain(CODE);
  });

  it("is CLEAN when every entry's value type matches the declared field", async () => {
    expect(
      await codes('operation setp() { price := Coin { amount: 5.0, currency: "USD" } }'),
    ).not.toContain(CODE);
  });

  it("admits ergonomic numeric-literal promotion (int literal into a decimal field)", async () => {
    expect(
      await codes('operation setp() { price := Coin { amount: 5, currency: "USD" } }'),
    ).not.toContain(CODE);
  });

  it("types the value against the operation's param env", async () => {
    // `c: Coin` param flows in; assigning it whole is fine, and its fields carry
    // through — a well-typed construction from a param stays clean.
    expect(
      await codes(
        "operation setp(c: Coin) { price := Coin { amount: c.amount, currency: c.currency } }",
      ),
    ).not.toContain(CODE);
  });

  it("rejects a param of the wrong type in a field", async () => {
    // `n: string` into the decimal `amount` field → flagged.
    expect(
      await codes('operation setp(n: string) { price := Coin { amount: n, currency: "USD" } }'),
    ).toContain(CODE);
  });

  it("suppresses on an unresolvable (unknown) value — reported once at its source, not doubly here", async () => {
    // `nope` is an undeclared name → typed unknown → the field-type check stays
    // silent (the unknown-name check owns that diagnostic).
    expect(
      await codes('operation setp() { price := Coin { amount: nope, currency: "USD" } }'),
    ).not.toContain(CODE);
  });
});
