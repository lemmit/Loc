// `loom.construction-field-type` at the NON-body construction sites (M-T6.18,
// gap #1 completion) — a record built with `X { field: value }` in a property
// default, a `derived` expression, an `invariant`, or a `function` body is
// type-checked the same as one in an operation body.  These sites walk their
// own env (not `checkStatement`), so they invoke `checkConstructionArgTypes`
// directly.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (members: string) => `
system Demo {
  subdomain S {
    context C {
      valueobject Coin { amount: decimal  currency: string }
      aggregate Order with crudish {
        qty: int
        ${members}
      }
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

const CODE = "loom.construction-field-type";

describe("loom.construction-field-type at non-body sites (M-T6.18)", () => {
  it("flags a wrong-typed field in a property DEFAULT construction", async () => {
    expect(await codes('price: Coin = Coin { amount: "x", currency: "USD" }')).toContain(CODE);
  });

  it("is CLEAN for a well-typed property default construction", async () => {
    expect(await codes('price: Coin = Coin { amount: 0.0, currency: "USD" }')).not.toContain(CODE);
  });

  it("flags a wrong-typed field in a DERIVED construction", async () => {
    expect(await codes('derived price: Coin = Coin { amount: "x", currency: "USD" }')).toContain(
      CODE,
    );
  });

  it("flags a wrong-typed field in a FUNCTION body construction", async () => {
    expect(await codes('function mk(): Coin = Coin { amount: "x", currency: "USD" }')).toContain(
      CODE,
    );
  });

  it("is CLEAN for a well-typed function-body construction", async () => {
    expect(
      await codes('function mk(): Coin = Coin { amount: 1.5, currency: "USD" }'),
    ).not.toContain(CODE);
  });
});
