// Hono route coverage for single-success union finds (`find x(): Agg or Err`).
// Per exception-less.md §4 ("success bodies carry the variant data directly
// with HTTP 200"), the correct wire is: the 200 body is the SUCCESS variant
// directly (`<Agg>Response`) — no tagged `oneOf` component — and the
// error/absent variant is a separate status response (RFC-7807 ProblemDetails
// at its mapped status).  A single-success union find is therefore wire-
// identical to `<Agg>?` / `<Agg> option`; the discriminated-union component
// survives only for genuine multi-success unions (none exist today).  The
// repository method is the optional single-row select.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order { code: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateHono(await parseValid(SRC));
}

async function routes(): Promise<string> {
  return (await files()).get("http/order.routes.ts")!;
}

describe("hono routes — discriminated-union finds (P4b)", () => {
  it("does NOT emit a tagged union DTO for a single-success find", async () => {
    const r = await routes();
    // The error variant belongs at its status, not in a 200 union component,
    // so a single-success union find declares no `oneOf` component at all.
    expect(r).not.toContain("OrderOrNotFound");
    expect(r).not.toContain("z.discriminatedUnion");
  });

  it("wires the success variant (<Agg>Response) as the find route's 200 schema", async () => {
    const r = await routes();
    expect(r).toMatch(/content: \{ "application\/json": \{ schema: OrderResponse \} \} \},/);
  });

  it("declares the absent variant's ProblemDetails status on the route", async () => {
    const r = await routes();
    expect(r).toContain(
      '404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },',
    );
  });

  it("returns the found row directly (untagged) on 200", async () => {
    const r = await routes();
    expect(r).toContain(
      "return c.json(repo.toWire(result) as z.infer<typeof OrderResponse>, 200);",
    );
  });

  it("translates absence to ProblemDetails with the resource extension", async () => {
    const r = await routes();
    expect(r).toContain("if (result == null) {");
    expect(r).toContain(
      'return c.json({ resource: "Order", type: "/errors/not-found", title: "Not Found", status: 404, detail: "Not Found", instance: c.req.path }, 404, { "content-type": "application/problem+json" });',
    );
  });

  it("the repository method is the optional single-row select", async () => {
    const repo = (await files()).get("db/repositories/order-repository.ts")!;
    expect(repo).toContain("async recent(): Promise<Order | null> {");
    expect(repo).toContain(".limit(1);");
  });
});
