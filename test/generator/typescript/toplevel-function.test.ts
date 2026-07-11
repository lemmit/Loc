// Phase B — the payoff test: a top-level function call renders on the Hono
// backend as its INLINED body (no emitted function, no `this.<fn>` call),
// through existing expression paths.  The same inlining reaches every backend;
// TS is the representative pin.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  function isBlank(s: string): bool = s.trim().length == 0
  function taxed(amount: int, pct: int): int = amount + amount * pct / 100

  context Sales {
    aggregate Invoice {
      customerName: string
      net: int
      invariant !isBlank(customerName)
      derived gross: int = taxed(net, 20)
    }
    repository Invoices for Invoice { }
  }
`;

describe("typescript generator — Phase B top-level function", () => {
  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("inlines the function body at the call site (no emitted function)", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/invoice.ts")!;
    // `taxed(net, 20)` inlined, paren-wrapped, args substituted.
    expect(domain).toContain("get gross(): number { return (this._net + this._net * 20 / 100); }");
    // `!isBlank(customerName)` inlined into the invariant guard.
    expect(domain).toContain("this._customerName.trim().length === 0");
    // No standalone helper method/function was emitted for the top-level
    // function (a param-signature would appear only if one were). The source
    // label `!isBlank(customerName)` does still echo in the invariant message.
    expect(domain).not.toContain("isBlank(s");
    expect(domain).not.toContain("taxed(amount");
    expect(domain).not.toContain("this.taxed");
  });
});
