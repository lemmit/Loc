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
    // The stream shares the per-context event log, so the fold codec reads the
    // shared `EventRecord` row (event-log-architecture.md).
    expect(state).toContain("public static IDomainEvent RowToEvent(OEventRecord __r)");
    expect(state).toContain("public static string ToData(IDomainEvent ev)");
  });

  it("registers the SHARED event log on the DbContext (no per-workflow record/table)", async () => {
    const files = await gen();
    // The workflow stream shares the per-context `<ctx>_events` log: ONE shared
    // `EventRecord` POCO + the per-context `<Ctx>EventRecordConfiguration` (ctx O).
    expect(file(files, "Persistence/Events/OEventRecord.cs")).toContain(
      "public sealed class OEventRecord",
    );
    // No per-workflow record entity.
    expect(
      [...files.keys()].some((k) => k.endsWith("Persistence/Events/TallyEventRecord.cs")),
    ).toBe(false);
    const dbctx = file(files, "Persistence/AppDbContext.cs");
    expect(dbctx).toContain("public DbSet<OEventRecord> OEvents => Set<OEventRecord>();");
    expect(dbctx).toContain(
      "modelBuilder.ApplyConfiguration(new Configurations.OEventRecordConfiguration());",
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
      'var __rows = await _eventStore.LoadStreamAsync("Tally", __sid, cancellationToken);',
    );
    expect(h).toContain(
      "var state = TallyState._FromEvents(__key, __rows.Select(TallyState.RowToEvent).ToList());",
    );
    expect(h).toContain("_eventStore.Append(new OEventRecord");
    expect(h).toContain('StreamType = "Tally",');
    expect(h).toContain("Data = TallyState.ToData(__ev),");
    expect(h).toContain("await _eventStore.SaveChangesAsync(cancellationToken);");
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

// Read-only instance endpoints for the event-sourced workflow
// (workflow-instance-visibility.md): route paths + operationIds + DTO identical
// to the state path (OpenAPI parity by construction); only the read body folds
// the `<wf>_events` stream instead of selecting the state DbSet.
describe("dotnet event-sourced workflow instance reads", () => {
  it("emits the instance Response record from the folded wire shape", async () => {
    const dto = file(await gen(), "Application/Workflows/TallyInstanceResponse.cs");
    expect(dto).toContain("public sealed record TallyInstanceResponse(");
  });

  it("LIST groups the event stream by StreamId and folds via _FromEvents", async () => {
    const ctrl = file(await gen(), "Api/OWorkflowInstancesController.cs");
    expect(ctrl).toContain('[HttpGet("tally/instances")]');
    expect(ctrl).toContain("public async Task<IActionResult> AllTallyInstances()");
    expect(ctrl).toContain(
      'var __rows = await _db.OEvents.AsNoTracking().Where(e => e.StreamType == "Tally").OrderBy(e => e.StreamId).ThenBy(e => e.Version).ToListAsync();',
    );
    expect(ctrl).toContain(
      "var rows = __rows.GroupBy(e => e.StreamId).Select(g => TallyState._FromEvents(new OrderId(Guid.Parse(g.Key)), g.Select(TallyState.RowToEvent).ToList()));",
    );
    // Not the state-table select.
    expect(ctrl).not.toContain("await _db.TallyStates");
  });

  it("byId folds one stream + 404s on an empty one", async () => {
    const ctrl = file(await gen(), "Api/OWorkflowInstancesController.cs");
    expect(ctrl).toContain('[HttpGet("tally/instances/{id}")]');
    expect(ctrl).toContain("public async Task<IActionResult> GetTallyInstanceById(Guid id)");
    expect(ctrl).toContain("var __sid = id.ToString();");
    expect(ctrl).toContain(
      'var __rows = await _db.OEvents.AsNoTracking().Where(e => e.StreamType == "Tally" && e.StreamId == __sid).OrderBy(e => e.Version).ToListAsync();',
    );
    expect(ctrl).toContain("if (__rows.Count == 0) return NotFound();");
    expect(ctrl).toContain(
      "var x = TallyState._FromEvents(new OrderId(id), __rows.Select(TallyState.RowToEvent).ToList());",
    );
  });
});
