// Python / FastAPI emission for the explicit application/transport layer
// (unfoldable-api-derivation.md, A2 — the Python sibling of the .NET A1 gate):
// `commandHandler` / `queryHandler` context members → `app/application/<name>.py`
// async handlers, and `route <M> "<path>" -> <Ctx>.<Handler>` api bindings → one
// `app/http/<api>_routes.py` APIRouter that coerces wire path params and calls
// the handler.  FastAPI has no mediator, so the router→handler split stands in
// for .NET's controller→Mediator dispatch.  The generated project's real
// uv/ruff/mypy/pytest gate is LOOM_PYTHON_BUILD (verified separately).
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order ids guid { code: string; status: string; operation cancel() { status := "cancelled" } }
      repository Orders for Order { }
      commandHandler CancelOrder(orderId: Order id): Order id { let o = Orders.getById(orderId); o.cancel(); return o.id }
      queryHandler GetStatus(orderId: Order id): string { let o = Orders.getById(orderId); return o.status }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/cancellations" -> Ordering.CancelOrder
    route GET  "/orders/{orderId}/status"        -> Ordering.GetStatus
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

describe("python — explicit commandHandler/queryHandler → FastAPI", () => {
  it("emits the command handler: repo build, guarded-less load, mutate, save, return", async () => {
    const h = fileEndingWith(await files(), "app/application/cancel_order.py");
    // Domain-typed param (the router coerces the wire id → OrderId before calling).
    expect(h).toContain(
      "async def cancel_order(session: AsyncSession, order_id: OrderId) -> OrderId:",
    );
    // Repo constructed with the Noop dispatcher (no live channel in this system).
    expect(h).toContain("orders = OrderRepository(session, NoopDomainEventDispatcher())");
    // Load (repos raise inside get_by_id — no synthesized `?? throw`), mutate, save, return.
    expect(h).toContain("o = await orders.get_by_id(order_id)");
    expect(h).toContain("o.cancel()");
    expect(h).toContain("await orders.save(o)");
    expect(h).toContain("return o.id");
    // Every referenced symbol is imported (no NameError / F821).
    expect(h).toContain("from app.db.repositories.order_repository import OrderRepository");
    expect(h).toContain("from app.domain.events import NoopDomainEventDispatcher");
    expect(h).toContain("from app.domain.ids import OrderId");
  });

  it("emits the query handler returning the resolved value (no __bad__)", async () => {
    const h = fileEndingWith(await files(), "app/application/get_status.py");
    expect(h).toContain("async def get_status(session: AsyncSession, order_id: OrderId) -> str:");
    expect(h).toContain("o = await orders.get_by_id(order_id)");
    expect(h).toContain("return o.status");
    // A query neither mutates nor saves.
    expect(h).not.toContain(".save(");
    expect(h).not.toContain("__bad__");
  });

  it("emits one APIRouter per api dispatching each route to its handler", async () => {
    const ctrl = fileEndingWith(await files(), "app/http/sales_api_routes.py");
    expect(ctrl).toContain("router = APIRouter()");
    // Path placeholders snake-cased so FastAPI params bind; wire id coerced → OrderId.
    expect(ctrl).toContain(
      '@router.post("/orders/{order_id}/cancellations", operation_id="cancelOrder")',
    );
    expect(ctrl).toContain(
      "async def cancel_order_route(order_id: str, session: SessionDep) -> dict[str, object]:",
    );
    expect(ctrl).toContain("result = await cancel_order(session, OrderId(order_id))");
    expect(ctrl).toContain('return {"result": result}');
    // Query route.
    expect(ctrl).toContain('@router.get("/orders/{order_id}/status", operation_id="getStatus")');
    expect(ctrl).toContain("result = await get_status(session, OrderId(order_id))");
    // Handlers + coercion helpers imported.
    expect(ctrl).toContain("from app.application.cancel_order import cancel_order");
    expect(ctrl).toContain("from app.application.get_status import get_status");
    expect(ctrl).toContain("from app.domain.ids import OrderId");
  });

  it("registers the explicit-route router in main.py", async () => {
    const main = fileEndingWith(await files(), "app/main.py");
    expect(main).toContain("from app.http.sales_api_routes import router as sales_api_router");
    expect(main).toContain('app.include_router(sales_api_router, prefix="/api")');
  });
});
