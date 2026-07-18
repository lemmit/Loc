import type { EnrichedBoundedContextIR, WorkflowIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { collectJavaTypeImports, renderJavaType } from "../render-expr.js";
import { collectJavaStmtImports, renderJavaStatements } from "../render-stmt.js";
import { javaStateDefault } from "./workflow-state.js";

// ---------------------------------------------------------------------------
// Event-sourced workflows on Java/Spring (workflow-and-applier.md A2-S5b) — the
// saga analogue of a `persistedAs(eventLog)` aggregate.  Instead of a mutable
// `<Wf>State` JPA entity + Spring Data repository, an `eventSourced` workflow
// persists as an append-only `<wf>_events` stream (keyed by the correlation
// field) and folds it through its `apply(...)` blocks on load, exactly like the
// aggregate event store (emit/event-store.ts).
//
// This module emits the per-workflow fold class `<Wf>State` (placed in the
// dispatcher's own `application.workflows` package, so its package-private
// state fields are reachable from the handler body's `state.<field>` reads):
//   - plain state fields (no JPA),
//   - `_apply<Event>` appliers rendered through the shared statement pipeline
//     with `this` as the receiver (the fold mutates this instance), then an
//     `_apply` dispatch + a `_fromEvents` rehydrator,
//   - the stream codec (`_rowToEvent` / `_toData`) reusing Jackson, mirroring
//     the aggregate event store.
//
// The fold-on-load / append-own-events handler is the ES branch of the
// dispatcher (emit/dispatch.ts), which threads a JdbcTemplate for stream IO.
// ---------------------------------------------------------------------------

/** Event-sourced workflows in a context. */
export function eventSourcedWorkflows(workflows: readonly WorkflowIR[]): WorkflowIR[] {
  return workflows.filter((wf) => wf.eventSourced);
}

/** The fold-target class name (`TallyState`). */
export function esWorkflowStateClass(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}State`;
}

/** The single per-context event log `<ctx>_events`, schema-qualified for native
 *  SQL when the context has a schema (e.g. `catalog_ctx.catalog_events`),
 *  matching the shared migration (`eventLogTableForStream`) and the other ports
 *  (event-log-architecture.md).  Every `persistedAs(eventLog)` aggregate AND
 *  every `eventSourced` workflow in the context shares this one table,
 *  discriminated by `stream_type`.  Unqualified when no schema — byte-identical
 *  for binding-free systems. */
export function esEventLogTable(ctxName: string, schema?: string): string {
  const base = `${snake(ctxName)}_events`;
  return schema ? `${schema}.${base}` : base;
}

/** The correlation field's id class (`OrderId`) — the stream key type.  The IR
 *  validator guarantees the correlation field is id-shaped. */
export function esWorkflowCorrIdClass(wf: WorkflowIR): string {
  const corr = wf.correlationField as string;
  const f = (wf.stateFields ?? []).find((x) => x.name === corr);
  const t = f && f.type.kind === "optional" ? f.type.inner : f?.type;
  if (t?.kind !== "id") {
    throw new Error(`java es-workflow: correlation field of '${wf.name}' must be id-typed`);
  }
  return `${t.targetName}Id`;
}

/** The fold class `<Wf>State`: plain state fields + `_apply<Event>` appliers +
 *  the `_apply` dispatch + the `_fromEvents` rehydrator + the Jackson codec.
 *  Lives in the dispatcher's package (`pkg`), NOT JPA-mapped — the stream is
 *  the source of truth, this is the in-memory fold. */
export function renderEsWorkflowFoldClass(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  basePkg: string,
  pkg: string,
): string {
  const cls = esWorkflowStateClass(wf);
  const corr = wf.correlationField as string;
  const corrId = esWorkflowCorrIdClass(wf);
  const fields = wf.stateFields ?? [];
  const stateOnly = fields.filter((f) => f.name !== corr);
  const eventNames = [...new Set((wf.appliers ?? []).map((a) => a.event))];
  const renderCtx = { thisName: "this" as const };

  const javaImports = new Set<string>();
  for (const f of fields) collectJavaTypeImports(f.type, javaImports);
  for (const ap of wf.appliers ?? []) collectJavaStmtImports(ap.statements, javaImports);

  // Plain state fields — package-private so the same-package handler body reads
  // them as `state.<field>` (no accessors needed; the fold target is internal).
  const fieldLines = [
    `    ${corrId} ${corr};`,
    ...stateOnly.map((f) => `    ${renderJavaType(f.type)} ${f.name};`),
  ];

  // Record-style public accessors (`<field>()`) so the cross-package
  // instance-read controller (api package) can project a folded instance the
  // same way it projects a JPA saga-state row — the package-private fields
  // alone aren't reachable from another package.
  const accessorMethods = [
    `    public ${corrId} ${corr}() { return this.${corr}; }`,
    ...stateOnly.map(
      (f) => `    public ${renderJavaType(f.type)} ${f.name}() { return this.${f.name}; }`,
    ),
  ];

  // `_apply<Event>` appliers — rendered through the shared statement pipeline
  // with `this` as the receiver (the fold mutates this instance's fields),
  // exactly like the aggregate's appliers.
  const applierMethods: string[] = [];
  for (const ap of wf.appliers ?? []) {
    applierMethods.push(`    private void _apply${ap.event}(${ap.event} ${ap.param}) {`);
    const body = renderJavaStatements(ap.statements, renderCtx, {
      emitTrace: false,
      aggregate: wf.name,
      op: `apply(${ap.event})`,
      eventSourced: true,
    });
    if (body.length > 0) applierMethods.push(body);
    applierMethods.push(`    }`);
    applierMethods.push("");
  }

  // Fold-from-zero: seed correlation key + a typed default per required
  // (non-optional, non-correlation) state field.
  const seeds = stateOnly
    .filter((f) => !(f.optional || f.type.kind === "optional"))
    .map((f) => `        s.${f.name} = ${javaStateDefault(f, ctx)};`);

  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    javaImports.size > 0 ? `` : null,
    `import java.util.List;`,
    ``,
    `import tools.jackson.databind.json.JsonMapper;`,
    ``,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** The folded saga state of an event-sourced workflow.  The truth is the`,
    ` *  ${esEventLogTable(ctx.name)} stream (its \`stream_type = "${wf.name}"\` rows);`,
    ` *  this is the in-memory projection, rebuilt on every dispatch via _fromEvents. */`,
    `public class ${cls} {`,
    `    private static final JsonMapper JSON = JsonMapper.builder().findAndAddModules().build();`,
    ``,
    ...fieldLines,
    ``,
    ...accessorMethods,
    ``,
    ...applierMethods,
    `    void _apply(DomainEvent ev) {`,
    `        switch (ev) {`,
    ...(wf.appliers ?? []).map((ap) => `            case ${ap.event} e -> _apply${ap.event}(e);`),
    `            default -> { }`,
    `        }`,
    `    }`,
    ``,
    `    public static ${cls} _fromEvents(${corrId} ${corr}, List<DomainEvent> events) {`,
    `        var s = new ${cls}();`,
    `        s.${corr} = ${corr};`,
    ...seeds,
    `        for (var ev : events) s._apply(ev);`,
    `        return s;`,
    `    }`,
    ``,
    `    public static DomainEvent _rowToEvent(String type, String data) {`,
    `        try {`,
    `            return switch (type) {`,
    ...eventNames.map((e) => `                case "${e}" -> JSON.readValue(data, ${e}.class);`),
    `                default -> throw new IllegalStateException("unknown event type: " + type);`,
    `            };`,
    `        } catch (tools.jackson.core.JacksonException e) {`,
    `            throw new IllegalStateException("event deserialization failed", e);`,
    `        }`,
    `    }`,
    ``,
    `    public static String _toData(DomainEvent ev) {`,
    `        try {`,
    `            return JSON.writeValueAsString(ev);`,
    `        } catch (tools.jackson.core.JacksonException e) {`,
    `            throw new IllegalStateException("event serialization failed", e);`,
    `        }`,
    `    }`,
    `}`,
    ``,
  );
}
