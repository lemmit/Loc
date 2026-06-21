// Hono route coverage for discriminated-union finds (payload-transport-layer.md,
// P4b — TS/Hono slice).  A `find x(): Agg or Err` emits a `z.discriminatedUnion`
// response DTO (each variant tagged on `type` + carrying its wire fields) and
// wires it as the find route's 200 response schema — byte-identical to the
// React client's schema (both derive from `unionMembers`).  Producer side
// (post the `loom.union-find-shape-unsupported` shape pinning): the repository
// method is the optional single-row select; the route tags a found row
// (`{ type: "<Agg>", …wire }`) and translates absence to an RFC-7807
// ProblemDetails at the absent variant's mapped status — the same edge
// translation the exception-less operation routes use.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order ids guid { code: string }
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
  it("emits a z.discriminatedUnion('type', …) DTO with both variants tagged", async () => {
    const r = await routes();
    expect(r).toContain('export const OrderOrNotFound = z.discriminatedUnion("type", [');
    expect(r).toContain('z.object({ type: z.literal("Order"), id: z.string(), code: z.string() })');
    expect(r).toContain('z.object({ type: z.literal("NotFound"), resource: z.string() })');
    expect(r).toContain('.openapi("OrderOrNotFound")');
  });

  it("wires the union DTO as the find route's 200 response schema", async () => {
    const r = await routes();
    expect(r).toMatch(/content: \{ "application\/json": \{ schema: OrderOrNotFound \} \} \},/);
  });

  it("declares the absent variant's ProblemDetails status on the route", async () => {
    const r = await routes();
    expect(r).toContain(
      '404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },',
    );
  });

  it("tags a found row with the success variant on 200", async () => {
    const r = await routes();
    expect(r).toContain(
      'return c.json({ type: "Order", ...(repo.toWire(result) as Record<string, unknown>) } as z.infer<typeof OrderOrNotFound>, 200);',
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
