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
});
