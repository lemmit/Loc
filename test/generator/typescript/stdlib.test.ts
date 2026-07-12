// Loom stdlib Phase C — the payoff: an ambient prelude call renders on the
// Hono backend as its INLINED body (no import, no emitted function), through
// existing expression paths. The same inlining reaches every backend.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Order {
      name: string
      invariant isPresent(name)
      derived blank: bool = isBlank(name)
      derived short: string = truncate(name, 8)
    }
    repository Orders for Order { }
  }
`;

describe("typescript generator — stdlib prelude", () => {
  it("parses + validates cleanly with no import", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("inlines prelude function bodies at the call site (no emitted function)", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/order.ts")!;
    // isBlank / isPresent / truncate all inlined, paren-wrapped, args substituted.
    expect(domain).toContain("get blank(): boolean { return (this._name.trim().length === 0); }");
    expect(domain).toContain("this._name.trim().length > 0");
    expect(domain).toContain("this._name.slice(0, (0) + (8))");
    // No standalone helper function emitted for the prelude.
    expect(domain).not.toContain("isBlank(s");
    expect(domain).not.toContain("truncate(s");
  });
});
