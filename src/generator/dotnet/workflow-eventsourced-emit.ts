import type { WorkflowIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import { renderEventRecordConfiguration, renderEventRecordPoco } from "./emit/event-store.js";
import { renderCsType } from "./render-expr.js";
import { renderCsStatements } from "./render-stmt.js";
import { csStateDefault, workflowStateClass } from "./workflow-state-emit.js";

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

/** The EF `DbSet` property name for a workflow's event stream (`<Wf>Events`),
 *  mirroring the aggregate `<Agg>Events` set. */
export function esEventDbSet(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}Events`;
}

/** The `<Wf>EventRecord` POCO class name. */
export function esEventRecordClass(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}EventRecord`;
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
function renderWorkflowFoldClass(wf: WorkflowIR, ns: string): string {
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
      `    public static IDomainEvent RowToEvent(${esEventRecordClass(wf)} __r)`,
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

/** Emit the fold class + event-record POCO + EF configuration for every
 *  event-sourced workflow.  No-op when none (byte-identical for non-ES). */
export function emitEventSourcedWorkflowFiles(
  workflows: readonly WorkflowIR[],
  ns: string,
  out: Map<string, string>,
  /** The saga stream's owning-context schema (workflow → context map-back);
   *  undefined → unqualified, byte-identical. */
  resolveWorkflowSchema: (wf: WorkflowIR) => string | undefined = () => undefined,
): void {
  for (const wf of eventSourcedWorkflows(workflows)) {
    out.set(`Application/Workflows/${workflowStateClass(wf)}.cs`, renderWorkflowFoldClass(wf, ns));
    out.set(
      `Infrastructure/Persistence/Events/${esEventRecordClass(wf)}.cs`,
      renderEventRecordPoco(upperFirst(wf.name), ns),
    );
    out.set(
      `Infrastructure/Persistence/Configurations/${esEventRecordClass(wf)}Configuration.cs`,
      renderEventRecordConfiguration(upperFirst(wf.name), ns, resolveWorkflowSchema(wf)),
    );
  }
}
