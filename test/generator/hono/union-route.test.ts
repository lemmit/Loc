// Hono route coverage for discriminated-union finds (payload-transport-layer.md,
// P4b — TS/Hono slice).  A `find x(): A or B` emits a `z.discriminatedUnion`
// response DTO (each variant tagged on `type` + carrying its wire fields) and
// wires it as the find route's 200 response schema — byte-identical to the
// React client's schema (both derive from `unionMembers`).

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order ids guid { code: string }
    aggregate Cancel ids guid { reason: string }
    repository Orders for Order { find recent(): Order or Cancel }
  }
`;

async function routes(): Promise<string> {
  const files = generateHono(await parseValid(SRC));
  return files.get("http/order.routes.ts")!;
}

describe("hono routes — discriminated-union finds (P4b)", () => {
  it("emits a z.discriminatedUnion('type', …) DTO with both variants tagged", async () => {
    const r = await routes();
    expect(r).toContain('export const OrderOrCancel = z.discriminatedUnion("type", [');
    expect(r).toContain('z.object({ type: z.literal("Order"), id: z.string(), code: z.string() })');
    expect(r).toContain(
      'z.object({ type: z.literal("Cancel"), id: z.string(), reason: z.string() })',
    );
    expect(r).toContain('.openapi("OrderOrCancel")');
  });

  it("wires the union DTO as the find route's 200 response schema", async () => {
    const r = await routes();
    expect(r).toMatch(/content: \{ "application\/json": \{ schema: OrderOrCancel \} \} \},/);
  });
});
