// Vanilla foundation — projection-sourced `view` emission (projection.md v1.1).
// A `view` whose `from` source is a projection reads the `<Proj>Row` read-model
// Ecto schema directly (no repository/context), with the filter pushed into the
// `where:`.  Shorthand (no `output`) projects the projection wire shape (the
// same shape the v1 `GET /api/projections/<slug>` controller returns); full form
// runs the bind projection, and — because the flat `<Proj>Row` schema carries no
// `belongs_to` — each `X id` follow bulk-loads its foreign aggregate by id into a
// `%{id => struct}` map (the Elixir sibling of Hono's `findManyByIds`).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/elixir-vanilla-build/vanilla-projection-view.ddd"),
  "utf8",
);

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("vanilla foundation — projection-sourced view", () => {
  it("full form: reads the <Proj>Row schema, bulk-loads the X id follow, projects binds", async () => {
    const files = await build();
    const view = files.get("sales_api/lib/sales_api/orders/views/shipped_orders.ex");
    expect(view, "projection view module not emitted").toBeDefined();
    // Row acquisition: a direct read of the read-model row schema (not a repo /
    // context), with the enum filter dumped to its declared string.
    expect(view).toContain(
      'from(record in SalesApi.Orders.Projections.OrderBookRow, where: record.status == "Shipped")',
    );
    expect(view).toContain("|> Repo.all()");
    // The `customer.name` follow bulk-loads Customer by id — the flat row schema
    // has no `belongs_to`, so it's an explicit `where: a.id in ^ids` load, not a
    // `Repo.preload`.
    expect(view).toContain(
      "Repo.all(from(a in SalesApi.Orders.Customer, where: a.id in ^Enum.map(rows, & &1.customer)))",
    );
    expect(view).toContain("|> Map.new(fn a -> {a.id, a} end)");
    expect(view).not.toContain("Repo.preload");
    // Bind projection: plain column reads + the rewritten follow.
    expect(view).toContain("orderId: record.order");
    expect(view).toContain("customerName: Map.get(customer_by_id, record.customer).name");
    expect(view).toContain("status: record.status");
    expect(view).toContain("@spec run(any()) :: [map()]");
  });

  it("shorthand form: projects the projection wire shape", async () => {
    const files = await build();
    const view = files.get("sales_api/lib/sales_api/orders/views/placed_order_books.ex");
    expect(view, "shorthand projection view module not emitted").toBeDefined();
    expect(view).toContain(
      'from(record in SalesApi.Orders.Projections.OrderBookRow, where: record.status == "Placed")',
    );
    expect(view).toContain(
      "|> Enum.map(fn record -> %{order: record.order, customer: record.customer, status: record.status} end)",
    );
  });

  it("wires both views into the project-wide ViewsController + routes", async () => {
    const files = await build();
    const controller = files.get("sales_api/lib/sales_api_web/controllers/views_controller.ex")!;
    expect(controller).toContain('@doc "GET /api/views/shipped_orders"');
    expect(controller).toContain("SalesApi.Orders.Views.ShippedOrders.run(current_user)");
    expect(controller).toContain("SalesApi.Orders.Views.PlacedOrderBooks.run(current_user)");
    // Projection views return plain maps → the identity `is_map` serialize clause.
    expect(controller).toContain("defp serialize(record) when is_map(record), do: record");
    // The read-model row schema the views read is emitted.
    expect(
      files.get("sales_api/lib/sales_api/orders/projections/order_book_row.ex"),
      "projection row schema not emitted",
    ).toBeDefined();
  });
});
