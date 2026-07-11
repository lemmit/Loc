// Projection-sourced views on Hono (projection.md v1.1): a `view` may name a
// `projection` as its `from` source.  The route reads the projection's
// `<Proj>Row` read-model table directly (no aggregate repository) with the
// filter lowered to a Drizzle `where`, then either:
//   - full form (`view X { fields … from <Proj> where … bind … }`) — runs the
//     shared aggregate bind tail (bulk-load `X id` follow foreign aggregates,
//     project each row through the binds), or
//   - shorthand (`view X = <Proj> where …`) — returns the raw rows as the
//     projection's `<Proj>ListResponse` (reused from the v1 read endpoint).
// The Hono sibling of the workflow-sourced-view emitter (hono-workflow-view).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Shop { subdomain Sales { context Orders {
  enum OrderStatus { Placed Shipped }
  event OrderPlaced  { order: Order id, customer: Customer id }
  event OrderShipped { order: Order id }
  aggregate Customer { name: string }
  repository Customers for Customer { }
  aggregate Order {
    status: OrderStatus
    create place(customer: Customer id) {}
    operation ship() { emit OrderShipped { order: id } }
  }
  repository Orders for Order { }
  channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
  projection OrderBook keyed by order {
    order: Order id
    customer: Customer id
    status: OrderStatus
    on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
    on(e: OrderShipped) { status := Shipped }
  }
  view ShippedOrders {
    orderId: Order id
    customerName: string
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, customerName = customer.name, status = status
  }
  view PlacedOrderBooks = OrderBook where status == Placed
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: node contexts: [Orders] dataSources: [oState] port: 3000 } }
`;

async function viewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/views.ts"));
  expect(path, "views.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono projection-sourced view — full form", () => {
  it("selects the <Proj>Row table directly with the filter lowered to a Drizzle where", async () => {
    const vf = await viewsFile();
    expect(vf).toContain(
      'const rows = await db.select().from(schema.orderBooks).where(eq(schema.orderBooks.status, "Shipped"));',
    );
    // Read is a runtime `schema` value import + the drizzle op is imported —
    // no repository for the projection SOURCE.
    expect(vf).toContain('import * as schema from "../db/schema";');
    expect(vf).toMatch(/import \{ eq \} from "drizzle-orm";/);
  });

  it("bulk-loads the `X id` follow aggregate into a Map (no projection repo)", async () => {
    const vf = await viewsFile();
    expect(vf).toContain(
      'import { CustomerRepository } from "../db/repositories/customer-repository";',
    );
    expect(vf).toContain("const customerRepo = new CustomerRepository(db, events);");
    expect(vf).toContain(
      "const customerById = new Map((await customerRepo.findManyByIds(rows.map((r) => r.customer))).map((a) => [a.id as string, a]));",
    );
  });

  it("projects each row through the bind expressions with the follow rewrite", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("orderId: r.order,");
    expect(vf).toContain("customerName: customerById.get(r.customer as string)!.name,");
    expect(vf).toContain("status: r.status,");
  });

  it("emits its own <View>Row / <View>Response schema from the declared fields", async () => {
    const vf = await viewsFile();
    expect(vf).toMatch(/const ShippedOrdersRow = z\.object\(\{/);
    expect(vf).toContain("orderId: z.string(),");
    expect(vf).toContain('status: z.enum(["Placed", "Shipped"]),');
    expect(vf).toContain("const ShippedOrdersResponse = z.array(ShippedOrdersRow)");
  });
});

describe("Hono projection-sourced view — shorthand", () => {
  it("selects the <Proj>Row table and returns the projection's <Proj>ListResponse", async () => {
    const vf = await viewsFile();
    expect(vf).toContain('path: "/placed_order_books",');
    expect(vf).toContain(
      'const rows = await db.select().from(schema.orderBooks).where(eq(schema.orderBooks.status, "Placed"));',
    );
    // Shorthand reuses the projection's existing list response (v1 read
    // endpoint) rather than declaring its own row schema.
    expect(vf).toContain('import { OrderBookListResponse } from "./projections";');
    expect(vf).toContain(
      "return httpCtx.json(rows as unknown as z.infer<typeof OrderBookListResponse>, 200);",
    );
  });
});
