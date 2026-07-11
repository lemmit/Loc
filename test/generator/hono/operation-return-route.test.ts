// Hono route coverage for exception-less operation returns (exception-less.md,
// spike — TS/Hono slice).  An `operation foo(): X or NotFound` returns its
// tagged `or`-union; the route captures the result, translates an `error`-
// variant (a payload declared with `error`) to an RFC-7807 ProblemDetails
// status (404 in the spike) and a success variant to HTTP 200.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order {
      code: string
      operation reserve(): Order or NotFound {
        return NotFound { resource: code }
      }
    }
  }
`;

async function routes(): Promise<string> {
  const files = generateHono(await parseValid(SRC));
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

  it("captures the operation result and translates an error variant to a ProblemDetails (A1 stdlib defaults)", async () => {
    const r = await routes();
    expect(r).toContain("const result = aggregate.reserve();");
    expect(r).toContain('if (result.type === "NotFound") {');
    // RFC-7807 problem+json with the stdlib-derived status / title / type URI
    // and the error payload's own fields riding along.
    expect(r).toContain('"content-type": "application/problem+json"');
    expect(r).toMatch(/c\.json\(\{ \.\.\.result,[^}]*status: 404/);
    expect(r).toContain('type: "/errors/not-found"');
    expect(r).toContain('title: "Not Found"');
    // NotFound's stdlib default status is declared as a problem+json response.
    expect(r).toMatch(
      /404: \{ description: "Not Found", content: \{ "application\/problem\+json": \{ schema: ProblemDetails \} \} \}/,
    );
  });

  it("returns the success variant as HTTP 200", async () => {
    const r = await routes();
    expect(r).toContain("return c.json(result, 200);");
  });
});
