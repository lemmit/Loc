// Hono emission for the `when` canCommand gate (criterion.md, use site 2).
//
// The operation route evaluates the predicate against the loaded aggregate
// before the body runs — false throws DisallowedError, which the shared
// onError maps to a 409 "Disallowed" ProblemDetails — and a side-effect-free
// `GET /{id}/can_<op>` companion returns `{ allowed }` for UI enablement.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    enum OrderStatus { Draft, Shipped, Cancelled }
    aggregate Order {
      status: OrderStatus
      operation cancel() when this.status != Shipped && this.status != Cancelled {
        status := Cancelled
      }
    }
    repository Orders for Order { }
  }
`;

async function routes(): Promise<string> {
  return generateHono(await parseValid(SRC)).get("http/order.routes.ts")!;
}

describe("hono routes — when canCommand gate", () => {
  it("gates the operation route with DisallowedError before the body", async () => {
    const r = await routes();
    expect(r).toContain(
      "if (!(aggregate.status !== OrderStatus.Shipped && aggregate.status !== OrderStatus.Cancelled)) throw new DisallowedError(\"operation 'cancel' is not allowed in the current state of Order.\");",
    );
    // The route declares the 409 outcome.
    expect(r).toContain(
      '409: { description: "Conflict", content: { "application/problem+json": { schema: ProblemDetails } } },',
    );
  });

  it("emits the side-effect-free can_<op> companion route", async () => {
    const r = await routes();
    expect(r).toContain('path: "/{id}/can_cancel"');
    expect(r).toContain("schema: z.object({ allowed: z.boolean() })");
    expect(r).toContain(
      "return c.json({ allowed: aggregate.status !== OrderStatus.Shipped && aggregate.status !== OrderStatus.Cancelled }, 200);",
    );
  });

  it("maps DisallowedError to a 409 Disallowed ProblemDetails in onError", async () => {
    const r = await routes();
    expect(r).toContain("if (err instanceof DisallowedError) {");
    expect(r).toContain('return problem(409, "Disallowed", err.message);');
  });

  it("an ungated operation emits no gate, can-route, or 409", async () => {
    const files = generateHono(
      await parseValid(`
        context Orders {
          aggregate Plain {
            note: string
            operation touch() { note := "x" }
          }
          repository Plains for Plain { }
        }
      `),
    );
    const r = files.get("http/plain.routes.ts")!;
    expect(r).not.toContain("DisallowedError(");
    expect(r).not.toContain("can_touch");
  });
});
