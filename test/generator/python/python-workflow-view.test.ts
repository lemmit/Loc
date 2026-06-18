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
    expect(main).toContain("app.include_router(views_router)");
  });
});
