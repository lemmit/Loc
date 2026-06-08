// Hono route coverage for exception-less operation returns (exception-less.md,
// spike — TS/Hono slice).  An `operation foo(): X or NotFound` returns its
// tagged `or`-union; the route captures the result, translates an `error`-
// variant (a payload declared with `error`) to an RFC-7807 ProblemDetails
// status (404 in the spike) and a success variant to HTTP 200.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order ids guid {
      code: string
      operation reserve(): Order or NotFound {
        return NotFound { resource: code }
      }
    }
  }
`;

async function routes(): Promise<string> {
  // Parsed without AST validation: payload construction in an expression
  // position (`return NotFound { … }`) isn't recognized by the builder-call
  // validator yet (a producer-track gap the earlier slices also worked around;
  // the route emission below is what this spike proves).
  const { model } = await parseString(SRC, { validate: false });
  const files = generateHono(model);
  return files.get("http/order.routes.ts")!;
}

describe("hono routes — exception-less operation returns (spike)", () => {
  it("emits the tagged-union response DTO for the operation return", async () => {
    const r = await routes();
    expect(r).toContain('export const OrderOrNotFound = z.discriminatedUnion("type", [');
    expect(r).toContain('z.object({ type: z.literal("NotFound"), resource: z.string() })');
  });

  it("wires the union DTO as the operation route's 200 response schema", async () => {
    const r = await routes();
    expect(r).toMatch(
      /200: \{ description: "OK", content: \{ "application\/json": \{ schema: OrderOrNotFound \} \} \}/,
    );
  });

  it("captures the operation result and translates an error variant to a 404 ProblemDetails", async () => {
    const r = await routes();
    expect(r).toContain("const result = aggregate.reserve();");
    expect(r).toContain('if (result.type === "NotFound") {');
    // RFC-7807 problem+json with the error payload's fields riding along.
    expect(r).toContain('"content-type": "application/problem+json"');
    expect(r).toMatch(/c\.json\(\{ \.\.\.result,[^}]*status: 404/);
    expect(r).toContain('detail: "Order.reserve returned NotFound"');
  });

  it("returns the success variant as HTTP 200", async () => {
    const r = await routes();
    expect(r).toContain("return c.json(result, 200);");
  });
});
