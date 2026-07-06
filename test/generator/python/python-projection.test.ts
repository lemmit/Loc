import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — projection read models (projection.md, v1).  A projection
// folds foreign events into a read-model table (`<Proj>Row`, non-key columns
// nullable), dispatched in-process via `app/dispatch.py`, and read through
// GET /projections/<snake> + /{key}.  Parity with the Hono runtime.
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
  deployable salesApi { platform: python contexts: [Orders] dataSources: [oState] port: 8000 } }`;

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe("python projection runtime", () => {
  it("emits a nullable-non-key SQLAlchemy read-model row", async () => {
    const schema = file(await build(), "app/db/schema.py");
    expect(schema).toContain("class OrderBookRow(Base):");
    expect(schema).toContain('__tablename__ = "order_books"');
    expect(schema).toContain(
      "order: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)",
    );
    // non-key columns nullable
    expect(schema).toMatch(
      /customer: Mapped\[str \| None\] = mapped_column\(Uuid\(as_uuid=False\)\)/,
    );
  });

  it("emits a pure fold handler wired into the in-process dispatcher", async () => {
    const dispatch = file(await build(), "app/dispatch.py");
    expect(dispatch).toContain("async def _proj_order_book_order_placed(");
    expect(dispatch).toContain("state = await _load_order_book(session, __key)");
    expect(dispatch).toContain("state = OrderBookRow(order=__key)");
    expect(dispatch).toContain("state.status = OrderStatus.Placed");
    // routed in the isinstance fan-out
    expect(dispatch).toContain("isinstance(event, OrderPlaced)");
    expect(dispatch).toContain("await _proj_order_book_order_placed(self._session, self, event)");
  });

  it("emits list + by-key read routes", async () => {
    const routes = file(await build(), "app/http/projections_routes.py");
    expect(routes).toContain('router = APIRouter(prefix="/projections", tags=["projections"])');
    expect(routes).toContain('@router.get("/order_book", response_model=OrderBookListResponse');
    expect(routes).toContain('@router.get("/order_book/{key}", response_model=OrderBookResponse');
    expect(routes).toContain("await session.get(OrderBookRow, key)");
  });

  it("mounts the projections router in main", async () => {
    const main = file(await build(), "app/main.py");
    expect(main).toContain("from app.http.projections_routes import router as projections_router");
    expect(main).toContain("app.include_router(projections_router");
  });
});
