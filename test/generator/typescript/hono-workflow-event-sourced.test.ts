// Event-sourced workflows on Hono (workflow-and-applier.md A2-S5b).  An
// `eventSourced` workflow persists to the single per-context `<ctx>_events`
// stream (its `stream_type` slice), folded through its `apply(...)` blocks —
// the saga analogue of a `persistedAs: eventLog` aggregate — instead of a
// mutable correlation-state row.  Asserts the shared stream table, the fold
// helpers, and the fold-load / append-own-events dispatch seam.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentReceived { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentReceived { order: p.order, amount: 0 } }
    on(pr: PaymentReceived) by pr.order { emit PaymentReceived { order: pr.order, amount: total } }
    apply(pr: PaymentReceived) { total := total + pr.amount }
  }
} } api A from O storage pg { type: postgres } deployable api { platform: node contexts: [O] serves: A port: 8080 } }`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("hono event-sourced workflows", () => {
  it("persists to the single per-context <ctx>_events stream, not a state table", async () => {
    const schema = file(await gen(), "db/schema.ts");
    // The ES workflow's stream lives in the shared per-context event log,
    // discriminated by stream_type — not a per-workflow `tally_events` table.
    expect(schema).toContain('pgTable("o_events"');
    expect(schema).toContain('streamType: text("stream_type").notNull(),');
    expect(schema).toContain("streamId: text(");
    expect(schema).toContain("version: integer(");
    expect(/pgTable\("tally_events"/.test(schema)).toBe(false);
    // No mutable correlation-state table for the event-sourced workflow.
    expect(/pgTable\("tally",/.test(schema)).toBe(false);
  });

  it("emits the fold helpers (state type, fold, apply, load, append)", async () => {
    const wf = file(await gen(), "http/workflows.ts");
    expect(wf).toContain("type TallyState = {");
    expect(wf).toContain("function applyTally(state: TallyState, ev: Events.DomainEvent): void {");
    // The applier folds against the plain `state` record (not `this._field`).
    expect(wf).toContain("state.total = state.total + pr.amount;");
    expect(wf).toContain(
      "function foldTally(key: string, events: Events.DomainEvent[]): TallyState {",
    );
    expect(wf).toContain("const state: TallyState = { orderId: key as Ids.OrderId, total: 0 };");
    expect(wf).toContain("async function loadTallyEvents(");
    expect(wf).toContain("async function appendTallyEvents(");
    expect(wf).toContain(
      'const Tally_FOLDED_EVENTS: ReadonlySet<string> = new Set(["PaymentReceived"]);',
    );
    // Reused stream (de)serialisers from the aggregate event store.
    expect(wf).toContain("function eventToData(ev: Events.DomainEvent)");
    expect(wf).toContain("function rowToEvent(row: { type: string; data: unknown })");
  });

  it("the create starter folds the stream, emits, and appends its own events", async () => {
    const wf = file(await gen(), "http/workflows.ts");
    expect(wf).toContain("export async function tallyStartOrderPlaced(");
    expect(wf).toContain("const __key = p.order;");
    expect(wf).toContain("const __stream = await loadTallyEvents(db, __key as string);");
    expect(wf).toContain("const state = foldTally(__key as string, __stream);");
    expect(wf).toContain(
      'workflowEvents.push({ type: "PaymentReceived", order: p.order, amount: 0 });',
    );
    expect(wf).toContain(
      "await appendTallyEvents(db, __key as string, workflowEvents.filter((e) => Tally_FOLDED_EVENTS.has(e.type)));",
    );
    expect(wf).toContain("for (const ev of workflowEvents) await events.dispatch(ev);");
  });

  it("the on-reactor drops + logs when the saga stream is empty", async () => {
    const wf = file(await gen(), "http/workflows.ts");
    expect(wf).toContain("export async function tallyOnPaymentReceived(");
    expect(wf).toContain("if (__stream.length === 0) {");
    expect(wf).toContain('event: "event_unrouted"');
    // The reactor reads folded state.
    expect(wf).toContain("amount: state.total");
  });

  it("wires both handlers into the in-process dispatcher", async () => {
    const wf = file(await gen(), "http/workflows.ts");
    expect(wf).toContain("export function createInProcessDispatcher(");
    expect(wf).toContain("await tallyStartOrderPlaced(db, dispatcher, event);");
    expect(wf).toContain("await tallyOnPaymentReceived(db, dispatcher, event);");
  });
});
