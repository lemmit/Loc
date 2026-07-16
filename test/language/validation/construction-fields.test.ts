// `loom.unknown-construction-field` (M-T6.18 slice 1) — a record built with
// `X { field: value }` may only name fields the record declares.

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

const CODE = "loom.unknown-construction-field";

describe("loom.unknown-construction-field (M-T6.18 slice 1)", () => {
  it("rejects an entry naming a field the value object doesn't declare", async () => {
    expect(
      await codes(
        'operation setp() { price := Coin { amount: money("5"), currency: "USD", bogus: 3 } }',
      ),
    ).toContain(CODE);
  });

  it("is CLEAN when every entry names a declared field", async () => {
    expect(
      await codes('operation setp() { price := Coin { amount: money("5"), currency: "USD" } }'),
    ).not.toContain(CODE);
  });

  it("is CLEAN for a partial construction (an omitted field is not an unknown-field error)", async () => {
    expect(await codes('operation setp() { price := Coin { amount: money("5") } }')).not.toContain(
      CODE,
    );
  });

  it("also covers ERROR / record-payload construction (exception-less returns)", async () => {
    const errSys = (ret: string) => `
system Demo {
  subdomain S {
    context C {
      error NotFound { resource: string  code: int }
      aggregate Order with crudish {
        sku: string
        operation confirm(): Order or NotFound { ${ret} }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;
    const errCodes = async (ret: string) =>
      codesOf((await parseString(errSys(ret), { validate: true })).diagnostics);
    // `bogus` is not a field of NotFound → flagged.
    expect(await errCodes('return NotFound { resource: "x", code: 1, bogus: 2 }')).toContain(CODE);
    // all declared fields → clean.
    expect(await errCodes('return NotFound { resource: "x", code: 1 }')).not.toContain(CODE);
  });
});
