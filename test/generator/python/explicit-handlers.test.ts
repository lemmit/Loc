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

// B2 — the Python slice of the [FromBody] fan-out (mirrors .NET B1/#1822):
// a handler param NOT bound by a `{token}` in the route path must ride in one
// `body: <Handler>Body` request model, not as a bare FastAPI param (which binds
// a scalar from the query string and a Pydantic model as THE top-level body).
const BODY_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      valueobject Money { amount: int; currency: string }
      aggregate Order ids guid { code: string; status: string; operation discount(amount: Money, reason: string) { status := reason } }
      repository Orders for Order { }
      commandHandler Discount(orderId: Order id, amount: Money, reason: string): Order id { let o = Orders.getById(orderId); o.discount(amount, reason); return o.id }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/discounts" -> Ordering.Discount
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("python — explicit handler body params → single request model", () => {
  it("collects non-path params into one <Handler>Body model bound as `body`", async () => {
    const m = await generateSystemFiles(BODY_SRC);
    const ctrl = fileEndingWith(m, "app/http/sales_api_routes.py");
    // The request model: path param (orderId) excluded, body params snake-cased
    // with their request wire types (Money → its wire model MoneyModel).
    expect(ctrl).toContain("class DiscountBody(BaseModel):");
    expect(ctrl).toContain("    amount: MoneyModel");
    expect(ctrl).toContain("    reason: str");
    // Route signature: real path param stays a `str` path param; the rest ride
    // in the single `body: DiscountBody`.
    expect(ctrl).toContain(
      "async def discount_route(order_id: str, body: DiscountBody, session: SessionDep) -> dict[str, object]:",
    );
    // Call args stay in declared order; body params read off `body.<snake>`,
    // then coerce to the DOMAIN class (Money(...) constructed from body fields).
    expect(ctrl).toContain(
      "result = await discount(session, OrderId(order_id), Money(body.amount.amount, body.amount.currency), body.reason)",
    );
    // Imports: the wire model (X as XModel) for the field type, the domain class
    // for the coercion, BaseModel for the model, and OrderId for the path coerce.
    expect(ctrl).toContain("from pydantic import BaseModel");
    expect(ctrl).toContain("from app.http.wire_models import Money as MoneyModel");
    expect(ctrl).toContain("from app.domain.value_objects import Money");
    expect(ctrl).toContain("from app.domain.ids import OrderId");
  });
});
