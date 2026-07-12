// Workflow-sourced views on Python (workflow-instance-views.md): `view X =
// <Workflow> where <pred>` emits a GET /views/<x> route reading the saga-state
// row with the predicate lowered to a SQLAlchemy `where`, plus a `<View>Row` /
// `<View>Response` DTO over the workflow's instance wire shape — the Python
// sibling of the Hono / .NET workflow-view emitters.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Order { total: int }
        enum FulfillmentStatus { Pending, Shipped }
        event PaymentReceived { order: Order id, amount: int }
        channel Lifecycle { carries: PaymentReceived  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment {
          orderId: Order id
          status: FulfillmentStatus
          create(paid: PaymentReceived) by paid.order { let x = paid.amount }
        }
        view ActiveFulfillments = OrderFulfillment where status == Pending
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: python  contexts: [Ops]  port: 3000 }
  }
`;

async function viewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("app/http/views_routes.py"));
  expect(path, "views_routes.py not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Python workflow-sourced view", () => {
  it("emits a <View>Row / <View>Response DTO from the saga instance shape", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("class ActiveFulfillmentsRow(BaseModel):");
    expect(vf).toContain("    orderId: str");
    expect(vf).toContain("    status: FulfillmentStatus");
    expect(vf).toContain(
      "class ActiveFulfillmentsResponse(RootModel[list[ActiveFulfillmentsRow]]):",
    );
  });

  it("emits a GET /active_fulfillments route reading the saga row with the lowered filter", async () => {
    const vf = await viewsFile();
    expect(vf).toContain(
      '@router.get("/active_fulfillments", response_model=ActiveFulfillmentsResponse, operation_id="activeFulfillmentsView")',
    );
    expect(vf).toContain(
      "async def active_fulfillments_view(session: SessionDep) -> list[dict[str, object]]:",
    );
    expect(vf).toContain(
      "rows = (await session.execute(select(OrderFulfillmentRow).where((OrderFulfillmentRow.status == FulfillmentStatus.Pending)))).scalars().all()",
    );
    expect(vf).toContain(
      'return [{"orderId": row.order_id, "status": row.status} for row in rows]',
    );
  });

  it("imports the saga row, select, and the enum — no aggregate repo", async () => {
    const vf = await viewsFile();
    expect(vf).toContain("from app.db.schema import OrderFulfillmentRow");
    expect(vf).toContain("from sqlalchemy import select");
    expect(vf).toContain("from app.domain.value_objects import FulfillmentStatus");
    expect(vf).toContain("from pydantic import BaseModel, RootModel");
    // No aggregate repository / dispatcher wiring for a workflow-only views file.
    expect(vf).not.toContain("Repository");
    expect(vf).not.toContain("make_dispatcher");
    expect(vf).not.toContain("NoopDomainEventDispatcher");
  });

  it("mounts the views router in main.py", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.http.views_routes import router as views_router");
    expect(main).toContain('app.include_router(views_router, prefix="/api")');
  });
});

// An event-sourced workflow has no `<Wf>Row` correlation table, so a
// `view = <ESWorkflow>` can't push its filter into a SQLAlchemy `where`.  The
// route group-folds the `<wf>_events` stream via `_load_all_<wf>` (the shared
// dispatch helper the ES instance LIST also uses) and applies the SAME predicate
// IN-MEMORY as a Python boolean over the folded state's attributes.  The
// operationId / route path / response component stay identical to the state path.
const ES_SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Order { total: int  create place() { total := 0  emit OrderPlaced { order: id } } }
        event OrderPlaced { order: Order id }
        event PaymentReceived { order: Order id, amount: int }
        channel Lifecycle { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment eventSourced {
          orderId: Order id
          paid: int
          create(p: OrderPlaced) by p.order { emit PaymentReceived { order: p.order, amount: 0 } }
          apply(pr: PaymentReceived) { paid := paid + pr.amount }
        }
        view PaidFulfillments = OrderFulfillment where paid > 0
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: python  contexts: [Ops]  port: 3000 }
  }
`;

async function esViewsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(ES_SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("app/http/views_routes.py"));
  expect(path, "views_routes.py not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Python event-sourced workflow-sourced view", () => {
  it("emits a <View>Row / <View>Response DTO from the ES instance shape", async () => {
    const vf = await esViewsFile();
    expect(vf).toContain("class PaidFulfillmentsRow(BaseModel):");
    expect(vf).toContain("    orderId: str");
    expect(vf).toContain("    paid: int");
    expect(vf).toContain("class PaidFulfillmentsResponse(RootModel[list[PaidFulfillmentsRow]]):");
  });

  it("reads the fold helper + filters IN-MEMORY (no SQLAlchemy select/where)", async () => {
    const vf = await esViewsFile();
    expect(vf).toContain("from app.dispatch import _load_all_order_fulfillment");
    expect(vf).toContain("    rows = await _load_all_order_fulfillment(session)");
    expect(vf).toContain(
      '    return [{"orderId": row.order_id, "paid": row.paid} for row in rows if row.paid > 0]',
    );
    // The ES read does NOT push the predicate into a SQLAlchemy select/where.
    expect(vf).not.toContain("select(");
    expect(vf).not.toContain(".where(");
  });

  it("keeps the same operationId + route path as the state path", async () => {
    const vf = await esViewsFile();
    expect(vf).toContain(
      '@router.get("/paid_fulfillments", response_model=PaidFulfillmentsResponse, operation_id="paidFulfillmentsView")',
    );
    expect(vf).toContain(
      "async def paid_fulfillments_view(session: SessionDep) -> list[dict[str, object]]:",
    );
  });
});
