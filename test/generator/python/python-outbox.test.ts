import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — durable-channel outbox tier (F3,
// dispatch-delivery-semantics.md).  A `retention: log | work` channel
// routes its events through the transactional outbox: an
// `OutboxDispatcher` wraps the in-process one and records durable events
// in `__loom_outbox` inside the request transaction; a background relay
// (`start_outbox_relay` → `_run_outbox_relay`) redelivers them
// at-least-once through the in-process dispatcher, ordered by
// occurred_at, dead-lettering after max_attempts; saga rows carry
// `last_event_id` for idempotent-consumer dedup, and chained emits clear
// the relayed id so they aren't deduped.  Verified live (place → outbox
// row → relay drain → Shipment Tracked → idempotent redelivery).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/outbox.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python durable-channel outbox", () => {
  it("schema gains the __loom_outbox table + last_event_id marker", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class LoomOutboxRow(Base):");
    expect(schema).toContain('__tablename__ = "__loom_outbox"');
    expect(schema).toContain('server_default=text("gen_random_uuid()")');
    expect(schema).toContain("payload: Mapped[object] = mapped_column(JSONB)");
    expect(schema).toContain("dispatched_at: Mapped[datetime | None]");
    expect(schema).toContain(
      'attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))',
    );
    // Idempotent-consumer marker on the saga row.
    expect(schema).toContain("last_event_id: Mapped[str | None] = mapped_column(Text)");
    // The shared migration also creates the outbox + marker column.
    const migration = [...files.entries()].find(
      ([p, c]) => p.startsWith("api/migrations/") && c.includes("__loom_outbox"),
    );
    expect(migration).toBeDefined();
    expect(migration![1]).toContain("last_event_id");
  });

  it("OutboxDispatcher records durable events; ephemeral fall through in-process", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain(
      '_DURABLE_EVENT_TYPES: frozenset[str] = frozenset({"OrderPlaced", "ShipmentRequested"})',
    );
    expect(dispatch).toContain("class OutboxDispatcher:");
    expect(dispatch).toContain("if event.type in _DURABLE_EVENT_TYPES:");
    expect(dispatch).toContain(
      "self._session.add(LoomOutboxRow(type=event.type, payload=_event_to_payload(event)))",
    );
    expect(dispatch).toContain("await self._inner.dispatch(event)");
    // make_dispatcher now wraps the in-process dispatcher in the outbox one.
    expect(dispatch).toContain('def make_dispatcher(session: AsyncSession) -> "OutboxDispatcher":');
    expect(dispatch).toContain("return OutboxDispatcher(session, InProcessDispatcher(session))");
  });

  it("payload (de)serialisers round-trip durable event fields", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain("def _event_to_payload(event: DomainEvent) -> dict[str, object]:");
    expect(dispatch).toContain('return {"order": event.order, "at": event.at.isoformat()}');
    expect(dispatch).toContain(
      "def _event_from_payload(event_type: str, payload: dict[str, object]) -> DomainEvent:",
    );
    expect(dispatch).toContain(
      'OrderPlaced(order=OrderId(cast(str, payload["order"])), at=datetime.fromisoformat(cast(str, payload["at"])))',
    );
  });

  it("relay drains undispatched rows in occurred_at order, dead-lettering after max_attempts", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    expect(dispatch).toContain(
      "async def _drain_outbox(max_attempts: int, batch_size: int) -> None:",
    );
    expect(dispatch).toContain(".where(LoomOutboxRow.dispatched_at.is_(None))");
    expect(dispatch).toContain(".where(LoomOutboxRow.attempts < max_attempts)");
    expect(dispatch).toContain(".order_by(LoomOutboxRow.occurred_at.asc())");
    expect(dispatch).toContain("token = _current_event_id.set(event_id)");
    expect(dispatch).toContain(".values(dispatched_at=datetime.now(UTC))");
    expect(dispatch).toContain("if next_attempts >= max_attempts:");
    expect(dispatch).toContain('"event_dead_lettered"');
    expect(dispatch).toContain('def start_outbox_relay() -> "asyncio.Task[None]":');
    expect(dispatch).toContain("return asyncio.create_task(_run_outbox_relay())");
  });

  it("saga handlers dedup on last_event_id; chained emits clear the relayed id", async () => {
    const files = await build();
    const dispatch = files.get("api/app/dispatch.py")!;
    // Idempotent-consumer dedup before running the body.
    expect(dispatch).toContain("__eid = _current_event_id.get()");
    expect(dispatch).toContain("if state.last_event_id == __eid:");
    expect(dispatch).toContain("state.last_event_id = __eid");
    // A handler's own emits dispatch with the relayed id cleared.
    expect(dispatch).toContain(
      "async def _dispatch_chained(events: InProcessDispatcher, event: DomainEvent) -> None:",
    );
    expect(dispatch).toContain("await _dispatch_chained(events, ev)");
  });

  it("the lifespan starts + cancels the relay background task", async () => {
    const files = await build();
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.dispatch import start_outbox_relay");
    expect(main).toContain("_outbox_relay = start_outbox_relay()");
    expect(main).toContain("_outbox_relay.cancel()");
  });
});
