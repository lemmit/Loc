import type { WorkflowIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import { eventDbSetName, eventRecordClass } from "./emit/event-store.js";
import { renderCsType } from "./render-expr.js";
import { renderCsStatements } from "./render-stmt.js";
import { csStateDefault, workflowStateClass } from "./workflow-state-emit.js";

// The per-context event log (event-log-architecture.md) collapses every
// event-sourced stream — aggregate and workflow — in a bounded context into ONE
// EF entity (`<Ctx>EventRecord`) + ONE `DbSet` (`<Ctx>Events`) per DbContext,
// discriminated by `StreamType`.  The type is per-context (not one shared
// `EventRecord`) because EF maps each CLR entity to a single table, so a
// deployable hosting several event-sourced contexts needs a distinct entity per
// `<ctx>_events` table.  `OwnerOf` maps a workflow to its OWNING context name
// (the emitter's `ctx` may be a merged union of several), so the workflow
// handlers, the aggregate repository, and the instance-read controllers all
// name the same per-context DbSet/POCO.
/** Maps a stream (aggregate/workflow) name to its OWNING bounded-context name. */
export type OwnerOf = (streamName: string) => string;

// ---------------------------------------------------------------------------
// Event-sourced workflows on .NET (workflow-and-applier.md A2-S5b) — the saga
// analogue of a `persistedAs(eventLog)` aggregate.  Instead of a mutable
// `<Wf>State` correlation row, an `eventSourced` workflow persists as an
// append-only `<wf>_events` stream (keyed by the correlation field) and folds
// it through its `apply(...)` blocks on load, exactly like the aggregate event
// store (emit/repository.ts:renderEventSourcedRepositoryImpl).
//
// This module emits the per-workflow fold machinery:
//   - a `<Wf>State` fold class (Application.Workflows): state properties +
//     `_Apply<Event>` appliers (rendered through the same `renderCsStatements`
//     pipeline as aggregate appliers, so `this.<Field>` resolves natively) +
//     an `_Apply` dispatch + a `_FromEvents` rehydrator + the stream codec
//     (`RowToEvent` / `ToData`);
//   - the `<Wf>EventRecord` POCO + EF configuration (reusing the aggregate
//     event-store emitters — the stream row shape is identical).
//
// The fold-on-load / append-own-events dispatch handler is the ES branch of
// `renderEventReactorHandler` (workflow-emit.ts).
// ---------------------------------------------------------------------------

/** Event-sourced workflows in a context. */
export function eventSourcedWorkflows(workflows: readonly WorkflowIR[]): WorkflowIR[] {
  return workflows.filter((wf) => wf.eventSourced);
}

/** The workflow's per-context event-log `DbSet` (`<Ctx>Events`) — every
 *  event-sourced workflow stream shares its OWNING context's log with that
 *  context's aggregates, discriminated by `StreamType` (see `esStreamType`). */
export function esEventDbSet(wf: WorkflowIR, ownerOf: OwnerOf): string {
  return eventDbSetName(ownerOf(wf.name));
}

/** The workflow's per-context event-log POCO class (`<Ctx>EventRecord`). */
export function esEventRecordClass(wf: WorkflowIR, ownerOf: OwnerOf): string {
  return eventRecordClass(ownerOf(wf.name));
}

/** A workflow's `stream_type` discriminator value in the shared per-context
 *  event log — the workflow's PascalCase name (mirrors the aggregate's
 *  `agg.name`).  Every load/append/fold for this workflow filters + stamps it
 *  so foreign streams sharing the `<ctx>_events` table are never folded in. */
export function esStreamType(wf: WorkflowIR): string {
  return upperFirst(wf.name);
}

/** The correlation field's id class (`OrderId`) — the stream key type.  The IR
 *  validator guarantees the correlation field is id-shaped. */
export function esCorrIdClass(wf: WorkflowIR): string {
  const corr = wf.correlationField as string;
  const f = (wf.stateFields ?? []).find((x) => x.name === corr);
  const t = f && f.type.kind === "optional" ? f.type.inner : f?.type;
  if (!t || t.kind !== "id") {
    throw new Error(`dotnet es-workflow: correlation field of '${wf.name}' must be id-typed`);
  }
  return `${t.targetName}Id`;
}

/** The fold-target `<Wf>State` class: state properties + appliers + the
 *  `_FromEvents` rehydrator + the stream codec.  Lives in Application.Workflows
 *  (the handler's namespace).  NOT EF-mapped — the stream is the source of
 *  truth, this is the in-memory fold. */
function renderWorkflowFoldClass(wf: WorkflowIR, ns: string, ownerOf: OwnerOf): string {
  const cls = workflowStateClass(wf);
  const corr = wf.correlationField as string;
  const corrId = esCorrIdClass(wf);
  const eventNames = [...new Set((wf.appliers ?? []).map((a) => a.event))];

  // State properties — same shape as the EF saga POCO, but plain (no mapping).
  const props = (wf.stateFields ?? []).map((f) => {
    const def = f.optional ? "" : " = default!;";
    return `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; set; }${def}`;
  });

  // `_Apply<Event>` appliers — rendered through the shared statement pipeline
  // with `this` as the receiver (the fold mutates this instance's properties),
  // exactly like the aggregate's appliers.
  const applierMethods: string[] = [];
  for (const ap of wf.appliers ?? []) {
    applierMethods.push(`    private void _Apply${ap.event}(${ap.event} ${ap.param})`);
    applierMethods.push("    {");
    const body = renderCsStatements(
      ap.statements,
      { thisName: "this" },
      {
        emitTrace: false,
        aggregate: wf.name,
        op: `apply(${ap.event})`,
        eventSourced: true,
      },
    );
    if (body.length > 0) applierMethods.push(body);
    applierMethods.push("    }");
    applierMethods.push("");
  }

  // Seed a from-zero fold: correlation key + a typed default per required
  // (non-optional, non-correlation) state field.
  const seeds = [`${upperFirst(corr)} = __key`];
  for (const f of wf.stateFields ?? []) {
    if (f.name === corr || f.optional) continue;
    seeds.push(`${upperFirst(f.name)} = ${csStateDefault(f.type)}`);
  }

  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Events;`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence.Events;`,
      "",
      `namespace ${ns}.Application.Workflows;`,
      "",
      "/// <summary>The folded saga state of an event-sourced workflow.  The",
      "/// truth is the `<wf>_events` stream; this is the in-memory projection,",
      "/// rebuilt from the stream on every dispatch via _FromEvents.</summary>",
      `public sealed class ${cls}`,
      "{",
      "    private static readonly System.Text.Json.JsonSerializerOptions __json =",
      "        new(System.Text.Json.JsonSerializerDefaults.Web);",
      ...props,
      "",
      ...applierMethods,
      "    private void _Apply(IDomainEvent ev)",
      "    {",
      "        switch (ev)",
      "        {",
      ...(wf.appliers ?? []).map(
        (ap) => `            case ${ap.event} e: _Apply${ap.event}(e); break;`,
      ),
      "        }",
      "    }",
      "",
      `    public static ${cls} _FromEvents(${corrId} __key, IReadOnlyList<IDomainEvent> events)`,
      "    {",
      `        var s = new ${cls} { ${seeds.join(", ")} };`,
      "        foreach (var ev in events) s._Apply(ev);",
      "        return s;",
      "    }",
      "",
      `    public static IDomainEvent RowToEvent(${esEventRecordClass(wf, ownerOf)} __r)`,
      "    {",
      "        return __r.Type switch",
      "        {",
      ...eventNames.map(
        (e) =>
          `            "${e}" => System.Text.Json.JsonSerializer.Deserialize<${e}>(__r.Data, __json)!,`,
      ),
      '            _ => throw new InvalidOperationException($"Unknown event type: {__r.Type}"),',
      "        };",
      "    }",
      "",
      "    public static string ToData(IDomainEvent ev) =>",
      "        System.Text.Json.JsonSerializer.Serialize((object)ev, __json);",
      "}",
    ) + "\n"
  );
}

/** Emit the fold class for every event-sourced workflow.  The event-record
 *  POCO + EF configuration are NOT per-workflow: the workflow's stream shares
 *  its OWNING context's `<ctx>_events` log (`<Ctx>EventRecord` POCO +
 *  `<Ctx>EventRecordConfiguration`, emitted once per context in index.ts).
 *  `ownerOf` maps each workflow back to its owning context (this `workflows`
 *  list may be a merged union).  No-op when none (byte-identical for non-ES). */
export function emitEventSourcedWorkflowFiles(
  workflows: readonly WorkflowIR[],
  ns: string,
  out: Map<string, string>,
  ownerOf: OwnerOf,
): void {
  for (const wf of eventSourcedWorkflows(workflows)) {
    out.set(
      `Application/Workflows/${workflowStateClass(wf)}.cs`,
      renderWorkflowFoldClass(wf, ns, ownerOf),
    );
  }
}
