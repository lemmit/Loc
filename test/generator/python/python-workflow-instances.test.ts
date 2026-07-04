import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — read-only workflow-instance endpoints
// (workflow-instance-visibility.md).  Every observable (correlation-bearing)
// workflow exposes its persisted saga-state row as an aggregate-shaped read
// model: GET /workflows/<snake>/instances (list) + /instances/{id} (one by
// correlation id, 404 if absent), projecting `instanceWireShape` — parity with
// the Hono / .NET / Elixir-vanilla instance reads.  The fixture's
// OrderFulfillment is event-triggered ONLY (no command route), so this also
// proves `workflows_routes.py` is emitted + mounted off observability alone.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/saga.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

// An event-sourced workflow (workflow-and-applier.md A2-S5b): correlation field
// + state field + applier.  The instance reads fold the per-correlation
// `<wf>_events` stream via the dispatch fold helpers instead of selecting a
// `<Wf>Row`.
const ES_SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentRegistered { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentRegistered  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
    on(pr: PaymentRegistered) by pr.order { precondition total >= 0  emit PaymentRegistered { order: pr.order, amount: total } }
    apply(pr: PaymentRegistered) { total := total + pr.amount }
  }
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: python contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

async function buildEs() {
  const { model, errors } = await parseString(ES_SRC);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files.get("api/app/http/workflows_routes.py")!;
}

describe("python workflow-instance endpoints", () => {
  it("emits + mounts workflows_routes.py for an event-triggered-only saga", async () => {
    const files = await build();
    // The saga has no command workflow, only an event-triggered create — the
    // file exists purely because the workflow is observable.
    const wf = files.get("api/app/http/workflows_routes.py");
    expect(wf, "workflows_routes.py not emitted for an observable-only saga").toBeDefined();
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.http.workflows_routes import router as workflows_router");
    expect(main).toContain('app.include_router(workflows_router, prefix="/api")');
  });

  it("emits the instance Response DTO + RootModel list carrier", async () => {
    const wf = (await build()).get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain("class OrderFulfillmentInstanceResponse(BaseModel):");
    expect(wf).toContain("    orderId: str");
    expect(wf).toContain("    attempts: int");
    expect(wf).toContain(
      "class OrderFulfillmentInstanceListResponse(RootModel[list[OrderFulfillmentInstanceResponse]]):",
    );
    expect(wf).toContain("from pydantic import BaseModel, RootModel");
    expect(wf).toContain("from sqlalchemy import select");
    expect(wf).toContain("from app.db.schema import OrderFulfillmentRow");
  });

  it("emits the list endpoint reading the saga-state row", async () => {
    const wf = (await build()).get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain(
      '@router.get("/order_fulfillment/instances", response_model=OrderFulfillmentInstanceListResponse, operation_id="allOrderFulfillmentInstances")',
    );
    expect(wf).toContain(
      "async def order_fulfillment_instances(session: SessionDep) -> list[dict[str, object]]:",
    );
    expect(wf).toContain(
      "rows = (await session.execute(select(OrderFulfillmentRow))).scalars().all()",
    );
    expect(wf).toContain(
      'return [{"orderId": row.order_id, "attempts": row.attempts} for row in rows]',
    );
  });

  it("emits the by-id endpoint with a 404 over the correlation PK", async () => {
    const wf = (await build()).get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain(
      '@router.get("/order_fulfillment/instances/{id}", response_model=OrderFulfillmentInstanceResponse, operation_id="getOrderFulfillmentInstanceById", responses={404: {"model": ProblemDetails, "description": "Not Found"}})',
    );
    // Correlation-id param carries the uuid format every backend declares
    // (paramTypeDiffs parity — same ID_PARAM the aggregate routes use).
    expect(wf).toContain(
      'async def order_fulfillment_instance(id: Annotated[str, Path(json_schema_extra={"format": "uuid"})], session: SessionDep) -> dict[str, object]:',
    );
    expect(wf).toContain("row = await session.get(OrderFulfillmentRow, id)");
    expect(wf).toContain("if row is None:");
    expect(wf).toContain('raise AggregateNotFoundError("not_found")');
    expect(wf).toContain('return {"orderId": row.order_id, "attempts": row.attempts}');
    expect(wf).toContain("from app.domain.errors import AggregateNotFoundError");
    expect(wf).toContain("from app.http.problem import ProblemDetails");
  });
});

describe("python event-sourced workflow-instance endpoints", () => {
  it("imports the fold helpers from app.dispatch (not a <Wf>Row schema)", async () => {
    const wf = await buildEs();
    // ES instance reads reuse the dispatch fold machinery; no `TallyRow` schema.
    expect(wf).toContain(
      "from app.dispatch import _fold_tally, _load_all_tally, _load_tally_events",
    );
    expect(wf).not.toContain("from app.db.schema import TallyRow");
    expect(wf).not.toContain("TallyRow");
  });

  it("LIST folds every stream via _load_all_tally", async () => {
    const wf = await buildEs();
    expect(wf).toContain(
      '@router.get("/tally/instances", response_model=TallyInstanceListResponse, operation_id="allTallyInstances")',
    );
    expect(wf).toContain("rows = await _load_all_tally(session)");
    expect(wf).toContain('return [{"orderId": row.order_id, "total": row.total} for row in rows]');
    // Not the state-table select.
    expect(wf).not.toContain("select(TallyRow)");
  });

  it("byId loads + folds one stream, 404 on empty", async () => {
    const wf = await buildEs();
    expect(wf).toContain(
      '@router.get("/tally/instances/{id}", response_model=TallyInstanceResponse, operation_id="getTallyInstanceById"',
    );
    expect(wf).toContain("__stream = await _load_tally_events(session, id)");
    expect(wf).toContain("    if not __stream:");
    expect(wf).toContain('        raise AggregateNotFoundError("not_found")');
    expect(wf).toContain("    row = _fold_tally(id, __stream)");
    expect(wf).toContain('    return {"orderId": row.order_id, "total": row.total}');
  });
});
