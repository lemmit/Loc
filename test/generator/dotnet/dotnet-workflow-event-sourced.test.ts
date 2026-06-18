// Event-sourced workflows on .NET (workflow-and-applier.md A2-S5b).  An
// `eventSourced` workflow persists as an append-only `<wf>_events` stream
// folded through its `apply(...)` blocks — the saga analogue of a
// `persistedAs(eventLog)` aggregate — instead of a mutable correlation-state
// row.  Asserts the `<Wf>State` fold class, the `<Wf>EventRecord` registration,
// and the fold-load / append-own-events dispatch handlers.

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
  deployable api { platform: dotnet contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("dotnet event-sourced workflows", () => {
  it("emits a <Wf>State fold class (appliers + _FromEvents + codec)", async () => {
    const state = file(await gen(), "Application/Workflows/TallyState.cs");
    expect(state).toContain("public sealed class TallyState");
    // The applier folds against `this` (the fold-target instance), like an aggregate.
    expect(state).toContain("private void _ApplyPaymentRegistered(PaymentRegistered pr)");
    expect(state).toContain("Total = this.Total + pr.Amount;");
    expect(state).toContain("private void _Apply(IDomainEvent ev)");
    expect(state).toContain(
      "public static TallyState _FromEvents(OrderId __key, IReadOnlyList<IDomainEvent> events)",
    );
    expect(state).toContain("var s = new TallyState { OrderId = __key, Total = 0 };");
    expect(state).toContain("public static IDomainEvent RowToEvent(TallyEventRecord __r)");
    expect(state).toContain("public static string ToData(IDomainEvent ev)");
  });

  it("emits the <Wf>EventRecord + registers it on the DbContext (no state table)", async () => {
    const files = await gen();
    expect(file(files, "Persistence/Events/TallyEventRecord.cs")).toContain(
      "public sealed class TallyEventRecord",
    );
    const dbctx = file(files, "Persistence/AppDbContext.cs");
    expect(dbctx).toContain(
      "public DbSet<TallyEventRecord> TallyEvents => Set<TallyEventRecord>();",
    );
    expect(dbctx).toContain(
      "modelBuilder.ApplyConfiguration(new Configurations.TallyEventRecordConfiguration());",
    );
    // No mutable saga-state POCO/table for the event-sourced workflow.
    expect([...files.keys()].some((k) => k.endsWith("Workflows/TallyState.cs"))).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith("Persistence/Workflows/TallyState.cs"))).toBe(
      false,
    );
  });

  it("the create starter folds the stream and appends its own events", async () => {
    const h = file(await gen(), "Workflows/TallyStartOrderPlacedHandler.cs");
    expect(h).toContain("var __key = notification.Order;");
    expect(h).toContain("var __sid = __key.Value.ToString();");
    expect(h).toContain(
      "var __rows = await _db.TallyEvents.Where(e => e.StreamId == __sid).OrderBy(e => e.Version).ToListAsync(cancellationToken);",
    );
    expect(h).toContain(
      "var state = TallyState._FromEvents(__key, __rows.Select(TallyState.RowToEvent).ToList());",
    );
    expect(h).toContain("_db.TallyEvents.Add(new TallyEventRecord");
    expect(h).toContain("Data = TallyState.ToData(__ev),");
    expect(h).toContain("await _db.SaveChangesAsync(cancellationToken);");
    expect(h).toContain("await _events.DispatchAsync(ev, cancellationToken);");
  });

  it("the on-reactor drops + logs when the saga stream is empty and reads folded state", async () => {
    const h = file(await gen(), "Workflows/TallyOnPaymentRegisteredHandler.cs");
    expect(h).toContain("if (__rows.Count == 0)");
    expect(h).toContain('"event_unrouted"');
    // The precondition reads the folded state.
    expect(h).toContain("if (!(state.Total >= 0))");
  });
});
