import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Elixir-vanilla backend — projection read models (projection.md, v1).  A
// projection folds foreign events into a `<Proj>Row` Ecto read-model schema
// (non-key columns nullable), dispatched in-process via a pure fold handler on
// the context Dispatcher, and read through GET /api/projections/<snake>[/:key].
// Parity with the shipped Hono + Python + Java runtimes (4th backend).
// ---------------------------------------------------------------------------

const SRC = `system Shop { subdomain Sales { context Orders {
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
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [oState] port: 4000 } }`;

// A projection-less system (same shape, projection removed) — additivity guard.
const SRC_NO_PROJECTION = `system Shop { subdomain Sales { context Orders {
  enum OrderStatus { Placed Shipped }
  event OrderShipped { order: Order id }
  aggregate Order {
    status: OrderStatus
    operation ship() { emit OrderShipped { order: id } }
  }
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [oState] port: 4000 } }`;

async function build(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe("elixir-vanilla projection runtime", () => {
  it("emits a nullable-non-key Ecto read-model row keyed by the correlation id", async () => {
    const row = file(await build(SRC), "orders/projections/order_book_row.ex");
    expect(row).toContain("defmodule SalesApi.Orders.Projections.OrderBookRow do");
    expect(row).toContain("use Ecto.Schema");
    expect(row).toContain('@schema_prefix "orders"');
    expect(row).toContain("@primary_key {:order, :binary_id, autogenerate: false}");
    expect(row).toContain('schema "order_books" do');
    expect(row).toContain("field :customer, :binary_id");
    // enum non-key field → Ecto.Enum (so the fold's `:Placed` atom round-trips)
    expect(row).toContain("field :status, Ecto.Enum, values: [:Placed, :Shipped]");
    expect(row).toContain("timestamps()");
  });

  it("emits a pure fold handler (load-or-allocate → set → upsert) per subscribed event", async () => {
    const fold = file(await build(SRC), "orders/projections/order_book/on_order_placed.ex");
    expect(fold).toContain("defmodule SalesApi.Orders.Projections.OrderBook.OnOrderPlaced do");
    expect(fold).toContain("def handle(%SalesApi.Orders.Events.OrderPlaced{} = event) do");
    expect(fold).toContain("key = event.order");
    expect(fold).toContain(
      "case SalesApi.Repo.get(SalesApi.Orders.Projections.OrderBookRow, key) do",
    );
    expect(fold).toContain("nil -> %SalesApi.Orders.Projections.OrderBookRow{order: key}");
    expect(fold).toContain("state = %{state | customer: event.customer}");
    expect(fold).toContain("state = %{state | status: :Placed}");
    expect(fold).toContain(
      "{:ok, _} = SalesApi.Repo.insert_or_update(Ecto.Changeset.change(state))",
    );
    // the correlation `:=` is skipped (immutable primary key)
    expect(fold).not.toContain("state = %{state | order:");
    // pure fold — no saga route-or-drop machinery
    expect(fold).not.toContain("with_child_frame");
    expect(fold).not.toContain("event_unrouted");

    const shipped = file(await build(SRC), "orders/projections/order_book/on_order_shipped.ex");
    expect(shipped).toContain("state = %{state | status: :Shipped}");
  });

  it("fans each event to its projection fold in the context Dispatcher", async () => {
    const disp = file(await build(SRC), "orders/dispatcher.ex");
    expect(disp).toContain("def dispatch(%SalesApi.Orders.Events.OrderPlaced{} = event) do");
    expect(disp).toContain("SalesApi.Orders.Projections.OrderBook.OnOrderPlaced.handle(event)");
    expect(disp).toContain("SalesApi.Orders.Projections.OrderBook.OnOrderShipped.handle(event)");
  });

  it("emits a read controller + routes under /api/projections", async () => {
    const files = await build(SRC);
    const ctrl = file(files, "controllers/projections_controller.ex");
    expect(ctrl).toContain("defmodule SalesApiWeb.ProjectionsController do");
    expect(ctrl).toContain("def order_book_index(conn, _params) do");
    expect(ctrl).toContain("Enum.map(SalesApi.Repo.all(SalesApi.Orders.Projections.OrderBookRow)");
    expect(ctrl).toContain('def order_book_show(conn, %{"key" => key}) do');
    expect(ctrl).toContain("SalesApi.Repo.get(SalesApi.Orders.Projections.OrderBookRow, key)");
    expect(ctrl).toContain("ProblemDetails.not_found_response(conn");
    // wire projection off the projection wireShape
    expect(ctrl).toContain("order: row.order, customer: row.customer, status: row.status");

    const router = file(files, "_web/router.ex");
    expect(router).toContain(
      'get "/projections/order_book", ProjectionsController, :order_book_index',
    );
    expect(router).toContain(
      'get "/projections/order_book/:key", ProjectionsController, :order_book_show',
    );
  });

  it("emits nothing projection-related for a projection-less system (additivity)", async () => {
    const files = await build(SRC_NO_PROJECTION);
    const projectionFiles = [...files.keys()].filter(
      (k) => k.includes("/projections/") || k.endsWith("projections_controller.ex"),
    );
    expect(projectionFiles).toEqual([]);
  });
});
