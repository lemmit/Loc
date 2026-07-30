// A6 string interpolation — the payoff test: a backtick template renders on
// the Hono backend through the EXISTING `+` / `String(...)` concat path, with
// no interpolation-specific emitter.  (The same desugar reaches every backend;
// TS is the representative pin — cross-backend concat/convert is already
// covered by the string-concat suites.)

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Order {
      quantity: int
      customerName: string
      derived label: string = \`Order #{quantity} for {customerName}\`
      derived plain: string = \`no holes\`
      derived greeting: string = \`Hi {customerName}!\`
    }
    repository Orders for Order { }
  }
`;

describe("typescript generator — A6 string interpolation", () => {
  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders as native string concatenation (int hole via String(...))", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/order.ts")!;
    expect(domain).toContain(
      'get label(): string { return "Order #" + String(this._quantity) + " for " + this._customerName; }',
    );
    expect(domain).toContain('get plain(): string { return "no holes"; }');
    expect(domain).toContain('get greeting(): string { return "Hi " + this._customerName + "!"; }');
  });

  // The key i18n-slice-1 claim: on a backend the `, format` suffix is DROPPED
  // (the `i18nFormat` node renders as `inner`), so a formatted hole emits
  // byte-identically to the format-less one.  Only the JS/TS frontends' i18n
  // runtime formats it — the domain layer never sees the difference.
  it("drops the ICU format on the backend — byte-identical to a format-less hole", async () => {
    const domainOf = async (deriveBody: string): Promise<string> => {
      const src = `
        context Sales {
          aggregate Order {
            total: money
            ${deriveBody}
          }
          repository Orders for Order { }
        }
      `;
      const { model } = await parseString(src, { validate: false });
      const domain = generateHono(model).get("domain/order.ts")!;
      return domain.split("\n").find((l) => l.includes("get display")) ?? "";
    };
    const formatted = await domainOf(
      "derived display: string = `Total: {total, number, ::currency/USD}`",
    );
    const plain = await domainOf("derived display: string = `Total: {total}`");
    expect(formatted).toBe(plain);
    expect(formatted).toContain('return "Total: " + this._total.toString();');
  });
});
