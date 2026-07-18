// `loom.construction-missing-field` (M-T6.18) — a record construction
// `X { … }` must supply every REQUIRED field: a declared `Property` that is
// non-optional, has no `= default`, and isn't `provenanced`.  `contains`
// members (auto-default empty), optional (`T?`), and defaulted fields are not
// required.  Completes the record-construction gap (name + value type + presence).

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (decls: string, body: string) => `
system Demo {
  subdomain S {
    context C {
      ${decls}
      aggregate Order with crudish {
        price: Coin
        ${body}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(decls: string, body: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(decls, body), { validate: true });
  return codesOf(diagnostics);
}

const CODE = "loom.construction-missing-field";
const COIN = "valueobject Coin { amount: decimal  currency: string }";

describe("loom.construction-missing-field (M-T6.18)", () => {
  it("flags a construction omitting a required field", async () => {
    expect(await codes(COIN, "operation s() { price := Coin { amount: 5.0 } }")).toContain(CODE);
  });

  it("is CLEAN when every required field is supplied", async () => {
    expect(
      await codes(COIN, 'operation s() { price := Coin { amount: 5.0, currency: "USD" } }'),
    ).not.toContain(CODE);
  });

  it("does not require a field that has a default", async () => {
    const decls = 'valueobject Coin { amount: decimal  currency: string = "USD" }';
    expect(await codes(decls, "operation s() { price := Coin { amount: 5.0 } }")).not.toContain(
      CODE,
    );
  });

  it("does not require an optional field", async () => {
    const decls = "valueobject Coin { amount: decimal  currency: string?  }";
    expect(await codes(decls, "operation s() { price := Coin { amount: 5.0 } }")).not.toContain(
      CODE,
    );
  });

  it("does not require a contains member of an entity part", async () => {
    // A part's `contains` auto-defaults to empty — building it with only its
    // required scalar is complete.
    const decls = "valueobject Coin { amount: decimal  currency: string }";
    const body = `
      contains shipments: Shipment[]
      operation add() { shipments += Shipment { carrier: "dhl" } }
      entity Shipment { carrier: string  contains labels: Label[] }
      entity Label { zpl: string }`;
    expect(await codes(decls, body)).not.toContain(CODE);
  });

  it("flags a required field omitted from an error / record-payload return", async () => {
    const decls = `${COIN}
      error NotFound { resource: string  code: int }`;
    const body = 'operation c(): Order or NotFound { return NotFound { resource: "x" } }';
    expect(await codes(decls, body)).toContain(CODE);
  });
});
