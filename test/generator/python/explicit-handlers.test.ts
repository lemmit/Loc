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

// C2 — the Python slice of the aggregate-return wire projection (mirrors .NET
// C1/#1830): a handler whose return type resolves to an aggregate/entity must
// project the domain (SQLAlchemy) instance to its wire shape via the repo's
// `to_wire(...)` — the same projection the auto-derived read routes use — and
// annotate `-> dict[str, object]` (NOT the aggregate class, which the module
// never imports and which would mismatch the dict returned). Id / scalar returns
// stay unchanged.
const AGG_RETURN_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order { code: string; status: string; operation cancel() { status := "cancelled" } }
      repository Orders for Order { }
      queryHandler GetOrder(orderId: Order id): Order { let o = Orders.getById(orderId); return o }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/{orderId}" -> Ordering.GetOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("python — explicit handler returning an aggregate → to_wire projection", () => {
  it("projects the domain entity to its wire dict via repo.to_wire, annotated dict[str, object]", async () => {
    const m = await generateSystemFiles(AGG_RETURN_SRC);
    const h = fileEndingWith(m, "app/application/get_order.py");
    // The return annotation is the wire dict, NOT `-> Order` (which the module
    // never imports and which would mismatch the projected dict).
    expect(h).toContain(
      "async def get_order(session: AsyncSession, order_id: OrderId) -> dict[str, object]:",
    );
    expect(h).not.toContain("-> Order:");
    // Load, then project via the repo's to_wire instead of returning the raw row.
    expect(h).toContain("orders = OrderRepository(session, NoopDomainEventDispatcher())");
    expect(h).toContain("o = await orders.get_by_id(order_id)");
    expect(h).toContain("return orders.to_wire(o)");
    expect(h).not.toContain("    return o\n");
    // No stray domain-aggregate import (the annotation is a dict now).
    expect(h).not.toContain("import Order\n");
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

// M-T5.10 handler-param rewrite — a scaffolded handler takes a SINGLE
// `command`/`query` RECORD param.  The Python handler FLATTENS the record into
// its fields as flat domain-typed `def` params (byte-identical to the flat-param
// form), renders the body's `cmd.<field>` as the flat field local, and — for a
// read — declares `<Agg>Response`, mapped back to the entity and projected via
// `repo.to_wire(...)` (a collection read comprehends each element).  The router's
// `<Handler>Body` Pydantic model carries the SAME flat fields, so the wire is
// unchanged.
const SCAFFOLD_SRC = `
system Shop {
  subdomain Sales {
    context Ordering with scaffoldHandlers {
      valueobject Money { amount: decimal; currency: string }
      aggregate Order {
        code: string
        status: string
        total: Money
        create(code: string) { code := code  status := "new"  total := Money { amount: 0, currency: "USD" } }
        operation reprice(newTotal: Money) { total := newTotal }
      }
      repository Orders for Order {
        find byStatus(status: string): Order[] where this.status == status
      }
    }
  }
  api SalesApi with scaffoldApi(of: Sales)
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("python — scaffolded handlers consume record params (M-T5.10)", () => {
  it("create handler flattens the command record into flat def params + reads cmd.<field>", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    const h = fileEndingWith(m, "app/application/create_order.py");
    // The `cmd: CreateOrderCommand` record is FLATTENED into its fields as flat
    // domain-typed def params (not a single `cmd` object param).
    expect(h).toContain(
      "async def create_order(session: AsyncSession, code: str, status: str, total: Money) -> OrderId:",
    );
    // Body reads `cmd.code` / `cmd.status` / `cmd.total` as the flat field locals.
    expect(h).toContain("o = Order.create(code=code, status=status, total=total)");
    expect(h).toContain("return o.id");
    // The aggregate domain class is imported for the `Order.create(...)` factory.
    expect(h).toContain("from app.domain.order import Order");
  });

  it("operation handler flattens the command record + reads the VO field local", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    const h = fileEndingWith(m, "app/application/reprice_order.py");
    // Path-bound id stays a separate flat param; the record field flattens in.
    expect(h).toContain(
      "async def reprice_order(session: AsyncSession, order_id: OrderId, new_total: Money) -> None:",
    );
    expect(h).toContain("o.reprice(new_total)");
  });

  it("find handler projects the <Agg>Response collection via to_wire per element", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    const h = fileEndingWith(m, "app/application/by_status.py");
    // The declared `ByStatusQuery` record flattens to `status`; the `OrderResponse[]`
    // return normalises to the entity and projects each element via to_wire.
    expect(h).toContain(
      "async def by_status(session: AsyncSession, status: str) -> list[dict[str, object]]:",
    );
    expect(h).toContain("r = await orders.by_status(status)");
    expect(h).toContain("return [orders.to_wire(__e) for __e in r]");
  });

  it("get-by-id handler projects the single <Agg>Response via to_wire", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    const h = fileEndingWith(m, "app/application/get_order.py");
    expect(h).toContain(
      "async def get_order(session: AsyncSession, order_id: OrderId) -> dict[str, object]:",
    );
    expect(h).toContain("return orders.to_wire(o)");
  });

  it("the router's <Handler>Body carries the SAME flat fields as the record (wire-invariant)", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    const ctrl = fileEndingWith(m, "app/http/sales_api_routes.py");
    // The command record's fields ARE the request body fields (byte-identical to
    // the flat-param form); Money rides as its wire model MoneyModel.
    expect(ctrl).toContain("class CreateOrderBody(BaseModel):");
    expect(ctrl).toContain("    code: str");
    expect(ctrl).toContain("    status: str");
    expect(ctrl).toContain("    total: MoneyModel");
    // Call args flatten in declared order; the VO field coerces to the domain class.
    expect(ctrl).toContain(
      "result = await create_order(session, body.code, body.status, Money(body.total.amount, body.total.currency))",
    );
  });
});

// An `extern` handler is bodyless: the generated dispatch delegates to a
// scaffold-once, user-owned impl the user fills in (extern-handler Phase 1).
const EXTERN_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order { code: string }
      repository Orders for Order { }
      extern commandHandler PlaceOrder(code: string): Order id;
      extern queryHandler GetQuote(orderId: Order id): string;
    }
  }
  api SalesApi from Sales {
    route POST "/orders" -> Ordering.PlaceOrder
    route GET  "/orders/{orderId}/quote" -> Ordering.GetQuote
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: python, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;
describe("python — extern commandHandler / queryHandler", () => {
  it("the dispatch module delegates to the scaffold-once impl", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const dispatch = fileEndingWith(m, "app/application/place_order.py");
    expect(dispatch).toContain(
      "from app.application.impl.place_order_impl import place_order_impl",
    );
    expect(dispatch).toContain("return await place_order_impl(code)");
  });

  it("emits a scaffold-once impl that raises", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const impl = fileEndingWith(m, "app/application/impl/place_order_impl.py");
    expect(impl.split("\n")[0]).toContain("loom:scaffold-once");
    expect(impl).toContain("async def place_order_impl(code: str)");
    expect(impl).toContain("raise NotImplementedError(");
  });
});
