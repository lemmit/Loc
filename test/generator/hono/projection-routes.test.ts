// Hono runtime for projection read models (projection.md, v1 slice 2).
// Covers `http/projections.ts`: the pure fold handlers (load-or-allocate →
// apply → upsert), the `projectionTee` dispatcher decorator, and the read
// routes; plus the `createApp` composition in `http/index.ts`.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    enum OrderStatus { Placed Shipped }
    event OrderPlaced  { order: Order id, customer: Customer id }
    event OrderShipped { order: Order id }
    aggregate Customer { name: string }
    aggregate Order {
      status: OrderStatus
      create place(customer: Customer id) {}
      operation ship() { emit OrderShipped { order: id } }
    }
    channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
    projection OrderBook keyed by order {
      order: Order id
      customer: Customer id
      status: OrderStatus
      on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
      on(e: OrderShipped) { status := Shipped }
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateHono(await parseValid(SRC));
}

describe("hono projection runtime", () => {
  it("emits a fold handler that loads-or-allocates the row and upserts", async () => {
    const p = (await files()).get("http/projections.ts")!;
    expect(p).toContain("export async function foldOrderPlacedIntoOrderBook(");
    expect(p).toContain("const __key = e.order;");
    expect(p).toContain("(await loadOrderBook(db, __key)) ?? { order: __key }");
    expect(p).toContain("state.status = OrderStatus.Placed;");
    expect(p).toContain("onConflictDoUpdate({ target: schema.orderBooks.order, set: state })");
  });

  it("emits the projectionTee dispatcher decorator routing each event", async () => {
    const p = (await files()).get("http/projections.ts")!;
    expect(p).toContain("export function projectionTee(");
    expect(p).toContain('case "OrderPlaced":');
    expect(p).toContain('case "OrderShipped":');
    expect(p).toContain("await inner.dispatch(event);");
  });

  it("emits list + by-key read routes", async () => {
    const p = (await files()).get("http/projections.ts")!;
    expect(p).toContain('path: "/order_book",');
    expect(p).toContain('path: "/order_book/{key}",');
    expect(p).toContain("export function projectionsRoutes(");
  });

  it("composes projectionTee into createApp and mounts the routes", async () => {
    const idx = (await files()).get("http/index.ts")!;
    expect(idx).toContain('import { projectionsRoutes, projectionTee } from "./projections";');
    expect(idx).toContain("projectionTee(db,");
    expect(idx).toContain('app.route("/api/projections", projectionsRoutes(db));');
  });

  it("emits a nullable non-key read-model column in the drizzle schema", async () => {
    const schema = (await files()).get("db/schema.ts")!;
    // `order` is the PK; `customer` is a non-key column and must be nullable
    // (a fold upserts partial rows) — i.e. no `.notNull()`.
    expect(schema).toMatch(/customer: uuid\("customer"\),/);
  });
});
