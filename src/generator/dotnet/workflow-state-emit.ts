import type { TypeIR, WorkflowIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Persisted workflow-correlation state (.NET / EF Core).
//
// The .NET counterpart of the Hono persisted-correlation slice: a workflow
// that declares a correlation field (one id-shaped state field) gets a
// saga-instance table keyed by that field, with the remaining state fields as
// columns.  This emits the EF-mapped POCO + its `IEntityTypeConfiguration`;
// the DbSet + `ApplyConfiguration` wiring lives in `renderDbContext`
// (emit/efcore.ts), and the load-or-allocate / route-or-drop+log handler
// logic lives in `renderEventReactorHandler` (workflow-emit.ts).  The
// CREATE TABLE migration is already derived platform-neutrally
// (`workflowStateTableShape` in src/system/migrations-builder.ts).
//
// The table name (`plural(snake(wf.name))`, e.g. `order_fulfillments`) matches
// the migration's, so EF's runtime model and the canonical migration agree.
// ---------------------------------------------------------------------------

/** Workflows in a context that carry a persisted correlation *row* — a
 *  state-based saga.  Excludes `eventSourced` workflows: those persist as an
 *  append-only `<wf>_events` stream (workflow-eventsourced-emit.ts), not a
 *  mutable state row, so they get no EF state POCO / DbSet / table. */
export function correlationWorkflows(workflows: readonly WorkflowIR[]): WorkflowIR[] {
  return workflows.filter((wf) => !!wf.correlationField && !wf.eventSourced);
}

/** The EF table name for a workflow's state row — matches
 *  `workflowStateTableShape` in the migrations builder. */
export function workflowStateTable(wf: WorkflowIR): string {
  return plural(snake(wf.name));
}

/** The DbSet property name (`OrderFulfillments`) the handlers load/save through. */
export function workflowStateDbSet(wf: WorkflowIR): string {
  return plural(upperFirst(wf.name));
}

/** The state POCO class name (`OrderFulfillmentState`). */
export function workflowStateClass(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}State`;
}

/** Emit the state POCO + its EF configuration for every correlation-bearing
 *  workflow in the context.  No-op when none — byte-identical for projects
 *  without a saga. */
export function emitWorkflowStatePersistence(
  workflows: readonly WorkflowIR[],
  ns: string,
  out: Map<string, string>,
  /** Idempotent-consumer marker (dispatch-delivery-semantics.md §3): a
   *  durable channel adds `LastEventId` so handlers can no-op on the
   *  relay's at-least-once redelivery. */
  durable = false,
  /** The saga table's owning-context schema (workflow → context map-back);
   *  undefined → unqualified, byte-identical. */
  resolveWorkflowSchema: (wf: WorkflowIR) => string | undefined = () => undefined,
): void {
  for (const wf of correlationWorkflows(workflows)) {
    out.set(
      `Infrastructure/Persistence/Workflows/${workflowStateClass(wf)}.cs`,
      renderWorkflowStateEntity(wf, ns, durable),
    );
    out.set(
      `Infrastructure/Persistence/Configurations/${workflowStateClass(wf)}Configuration.cs`,
      renderWorkflowStateConfiguration(wf, ns, durable, resolveWorkflowSchema(wf)),
    );
  }
}

/** The saga-instance POCO: the correlation field plus every other state field
 *  as a public auto-property (EF maps it; handler bodies read/write
 *  `state.<Prop>` via the `thisName: "state"` seam). */
export function renderWorkflowStateEntity(wf: WorkflowIR, ns: string, durable = false): string {
  const props = (wf.stateFields ?? []).map((f) => {
    // Non-optional reference types need `= default!` to satisfy nullable
    // reference types; value types (int / record-struct ids) accept it too.
    const def = f.optional ? "" : " = default!;";
    return `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; set; }${def}`;
  });
  if (durable) {
    // Idempotent-consumer marker (dispatch-delivery-semantics.md §3): the
    // last processed outbox event id — the handler preamble no-ops on a
    // repeat under the relay's at-least-once redelivery.
    props.push("    public string? LastEventId { get; set; }");
  }
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Workflows;`,
      "",
      `public sealed class ${workflowStateClass(wf)}`,
      "{",
      ...props,
      "}",
    ) + "\n"
  );
}

/** The state row's EF configuration — mirrors the aggregate configuration's
 *  `ToTable` / `HasKey` / per-field `HasConversion` shape, keyed by the
 *  correlation field instead of `Id`. */
export function renderWorkflowStateConfiguration(
  wf: WorkflowIR,
  ns: string,
  durable = false,
  schema?: string,
): string {
  const corr = wf.correlationField as string;
  const cls = workflowStateClass(wf);
  // Saga state table lands in the workflow's context schema (two-arg ToTable);
  // undefined → single-arg, byte-identical.
  const toTableArgs = schema
    ? `"${workflowStateTable(wf)}", "${schema}"`
    : `"${workflowStateTable(wf)}"`;
  const fieldConfigs = (wf.stateFields ?? []).flatMap((f) => {
    // EVERY column carries an explicit `.HasColumnName(snake(f.name))` so the EF
    // model column name EQUALS the migration DDL column name — the migration
    // (migrations-builder.ts) names every column `snake(f.name)`.  Without it, EF
    // falls back to the PascalCase property name and a correlation lookup /
    // column read throws "column does not exist" at runtime (compile-green).
    const col = `.HasColumnName("${snake(f.name)}")`;
    if (f.type.kind === "id") {
      return [
        `        builder.Property(x => x.${upperFirst(f.name)}).HasConversion(v => v.Value, v => new ${f.type.targetName}Id(v))${col};`,
      ];
    }
    if (f.type.kind === "enum") {
      return [
        `        builder.Property(x => x.${upperFirst(f.name)}).HasConversion<string>()${col};`,
      ];
    }
    return [`        builder.Property(x => x.${upperFirst(f.name)})${col};`];
  });
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Metadata.Builders;",
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Infrastructure.Persistence.Workflows;`,
      "",
      `namespace ${ns}.Infrastructure.Persistence.Configurations;`,
      "",
      `public sealed class ${cls}Configuration : IEntityTypeConfiguration<${cls}>`,
      "{",
      `    public void Configure(EntityTypeBuilder<${cls}> builder)`,
      "    {",
      `        builder.ToTable(${toTableArgs});`,
      `        builder.HasKey(x => x.${upperFirst(corr)});`,
      ...fieldConfigs,
      // The marker column name matches the shared migration DDL
      // (`last_event_id`, dispatch-delivery-semantics.md §3).
      ...(durable
        ? [`        builder.Property(x => x.LastEventId).HasColumnName("last_event_id");`]
        : []),
      "    }",
      "}",
    ) + "\n"
  );
}

/** A backend-zero C# literal for a required saga-state column at allocation —
 *  the .NET analogue of the Hono `defaultLiteralFor`.  The correlation field
 *  is seeded from the routing key, never this. */
export function csStateDefault(t: TypeIR): string {
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
      case "money":
        return "0m";
      case "bool":
        return "false";
      case "datetime":
        return "DateTime.UtcNow";
      default:
        return '""';
    }
  }
  if (t.kind === "array") return "new()";
  return "default!";
}

/** The allocate-object initializer for a fresh saga instance: the correlation
 *  key plus a typed default for each required (non-optional, non-correlation)
 *  state field. */
export function workflowAllocateInitializer(wf: WorkflowIR, keyExpr: string): string {
  const corr = wf.correlationField as string;
  const parts = [`${upperFirst(corr)} = ${keyExpr}`];
  for (const f of wf.stateFields ?? []) {
    if (f.name === corr || f.optional) continue;
    parts.push(`${upperFirst(f.name)} = ${csStateDefault(f.type)}`);
  }
  return `new ${workflowStateClass(wf)} { ${parts.join(", ")} }`;
}
