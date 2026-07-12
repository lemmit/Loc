// Event-sourced workflows on Python/FastAPI (workflow-and-applier.md A2-S5b).
// An `eventSourced` workflow persists as an append-only `<wf>_events` stream
// folded through its `apply(...)` blocks — the saga analogue of a
// `persistedAs(eventLog)` aggregate — instead of a mutable correlation-state
// row.  Its stream lives in the single shared per-context `<ctx>_events` log
// (discriminated by `stream_type`).  Asserts the `<Wf>State` fold block, the
// shared event-log schema model, and the fold-load / append-own-events
// dispatch handlers.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S { subdomain O { context O {
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

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("python event-sourced workflows", () => {
  it("emits a <Wf>State fold block (appliers + _fold + codec) in dispatch.py", async () => {
    const d = file(await gen(), "app/dispatch.py");
    expect(d).toContain("class TallyState:");
    // The applier folds against the public `state` object (this.<field> seam).
    expect(d).toContain(
      "def _apply_tally_payment_registered(state: TallyState, pr: PaymentRegistered) -> None:",
    );
    expect(d).toContain("state.total = state.total + pr.amount");
    expect(d).toContain("def _apply_tally(state: TallyState, ev: DomainEvent) -> None:");
    expect(d).toContain("def _fold_tally(key: str, events: list[DomainEvent]) -> TallyState:");
    // Fold-from-zero seeds the correlation key + typed zeros for required fields.
    expect(d).toContain("state = TallyState(order_id=OrderId(key), total=0)");
    expect(d).toContain(
      "async def _load_tally_events(session: AsyncSession, key: str) -> list[DomainEvent]:",
    );
    expect(d).toContain(
      "async def _append_tally_events(session: AsyncSession, key: str, events: list[DomainEvent]) -> None:",
    );
  });

  it("appends its stream to the shared per-context event log (no mutable saga-state table)", async () => {
    const files = await gen();
    const schema = file(files, "app/db/schema.py");
    // ES workflows share the single per-context `<ctx>_events` log, keyed by
    // (stream_type, stream_id, version), discriminated by the workflow name.
    expect(schema).toContain("class OEventRow(Base):");
    expect(schema).toContain('__tablename__ = "o_events"');
    expect(schema).toContain('PrimaryKeyConstraint("stream_type", "stream_id", "version")');
    // No per-workflow stream table, no mutable saga-state row.
    expect(schema).not.toContain("class TallyEventRow(Base):");
    expect(schema).not.toContain("class TallyRow(Base):");
    // The append stamps the workflow's stream_type discriminator.
    const d = file(files, "app/dispatch.py");
    expect(d).toContain('stream_type="Tally",');
    expect(d).toContain('OEventRow.stream_type == "Tally"');
  });

  it("the create starter folds the stream and appends its own events", async () => {
    const d = file(await gen(), "app/dispatch.py");
    expect(d).toContain("__key = str(p.order)");
    expect(d).toContain("__events = await _load_tally_events(session, __key)");
    expect(d).toContain("state = _fold_tally(__key, __events)");
    expect(d).toContain("await _append_tally_events(session, __key, workflow_events)");
    expect(d).toContain("await events.dispatch(ev)");
  });

  it("the on-reactor drops + logs when the stream is empty and reads folded state", async () => {
    const d = file(await gen(), "app/dispatch.py");
    expect(d).toContain("if not __events:");
    expect(d).toContain('"event_unrouted"');
    // The precondition reads the folded state.
    expect(d).toContain("state.total >= 0");
  });
});
