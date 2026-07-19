import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — in-process event dispatch (plan S15b, channels.md).
// When a channel routes a subscribed event, `app/dispatch.py` carries
// one handler per (workflow, trigger, event): a `create(e) by …`
// starter loads-or-allocates the persisted correlation row, an
// `on(e) by …` reactor routes to the existing row or drops + logs
// `event_unrouted`.  The InProcessDispatcher passes itself to every
// handler so choreography chains re-enter; routes/views/workflows then
// construct repositories with `make_dispatcher(session)` instead of
// the Noop.  Verified live (POST /orders/{id}/place → saga row +
// shipment marked Tracked in one request transaction).
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

describe("python event dispatch (sagas)", () => {
  it("emits the saga-state SQLAlchemy model + migration table", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class OrderFulfillmentRow(Base):");
    expect(schema).toContain('__tablename__ = "order_fulfillments"');
    // Correlation column is the PK; saga state fields ride alongside.
    expect(schema).toContain(
      "order_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)",
    );
    expect(schema).toContain("attempts: Mapped[int]");
    const migration = [...files.entries()].find(
      ([p, c]) => p.startsWith("api/migrations/") && c.includes("order_fulfillments"),
    );
    expect(migration).toBeDefined();
  });

  it("starter handler loads-or-allocates the correlation row", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain("async def _order_fulfillment_create_order_placed(");
    expect(dispatch).toContain("__key = str(p.order)");
    expect(dispatch).toContain("state = await _load_order_fulfillment(session, __key)");
    expect(dispatch).toContain("state = OrderFulfillmentRow(order_id=__key, attempts=0)");
    expect(dispatch).toContain("session.add(state)");
    // Body executes + saves before its own emits re-dispatch.
    expect(dispatch).toContain('ship = Shipment.create(order_ref=p.order, status="Pending")');
    expect(dispatch).toContain("await shipments.save(ship)");
    expect(dispatch).toContain("await session.flush()");
    expect(dispatch).toContain("for ev in workflow_events:");
    expect(dispatch).toContain("await events.dispatch(ev)");
  });

  it("reactor handler routes to the existing row or drops + logs event_unrouted", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain("async def _order_fulfillment_on_shipment_requested(");
    expect(dispatch).toContain(
      'log("warn", "event_unrouted", workflow="OrderFulfillment", event_type="ShipmentRequested", key=__key)',
    );
    expect(dispatch).toContain("ship = await shipments.get_by_id(s.shipment)");
    expect(dispatch).toContain("ship.mark_tracked()");
  });

  it("dispatcher isinstance-fans events to handlers, passing itself for re-entry", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain("class InProcessDispatcher:");
    expect(dispatch).toContain("if isinstance(event, ShipmentRequested):");
    expect(dispatch).toContain(
      "await _order_fulfillment_on_shipment_requested(self._session, self, event)",
    );
    // saga.ddd's `Lifecycle` channel is `delivery: broadcast`, so make_dispatcher
    // wraps the in-process dispatcher in the realtime SSE tee (channels.md Part I).
    expect(dispatch).toContain(
      "def make_dispatcher(session: AsyncSession) -> RealtimeDispatcher:",
    );
    expect(dispatch).toContain("return RealtimeDispatcher(InProcessDispatcher(session))");
    // Handlers take the dispatcher so repo saves drain through it.
    expect(dispatch).toContain("shipments = ShipmentRepository(session, events)");
  });

  it("routes construct repositories with the live dispatcher instead of the Noop", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("from app.dispatch import make_dispatcher");
    expect(routes).toContain("return OrderRepository(session, make_dispatcher(session))");
    expect(routes).not.toContain("NoopDomainEventDispatcher");
  });

  it("channel-less projects keep the Noop wiring and emit no dispatch module", async () => {
    const source = FIXTURE.replace(/channel Lifecycle \{[\s\S]*?\n {6}\}\n/, "");
    expect(source).not.toContain("channel Lifecycle");
    const { model, errors } = await parseString(source);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect(files.get("api/app/dispatch.py")).toBeUndefined();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("NoopDomainEventDispatcher()");
    expect(routes).not.toContain("make_dispatcher");
  });
});
