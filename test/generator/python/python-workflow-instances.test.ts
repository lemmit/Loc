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
    expect(wf).toContain(
      "async def order_fulfillment_instance(id: str, session: SessionDep) -> dict[str, object]:",
    );
    expect(wf).toContain("row = await session.get(OrderFulfillmentRow, id)");
    expect(wf).toContain("if row is None:");
    expect(wf).toContain('raise AggregateNotFoundError("not_found")');
    expect(wf).toContain('return {"orderId": row.order_id, "attempts": row.attempts}');
    expect(wf).toContain("from app.domain.errors import AggregateNotFoundError");
    expect(wf).toContain("from app.http.problem import ProblemDetails");
  });
});
