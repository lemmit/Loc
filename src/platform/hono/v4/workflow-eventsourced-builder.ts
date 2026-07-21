import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import { tsParamType } from "../../../generator/typescript/repository-document-builder.js";
import {
  eventToDataFn,
  rowToEventFn,
} from "../../../generator/typescript/repository-eventsourced-builder.js";
import type {
  EnrichedBoundedContextIR,
  EventIR,
  StmtIR,
  TypeIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Event-sourced workflows on Hono (workflow-and-applier.md A2-S5b) — the saga
// analogue of a `persistedAs(eventLog)` aggregate.  Instead of a mutable
// `<wf>` correlation-state row, an `eventSourced` workflow persists as an
// append-only `<wf>_events` stream (keyed by the correlation field) and folds
// it through the `apply(...)` blocks at load time, exactly like the aggregate
// event store (repository-eventsourced-builder.ts).
//
// This module emits the per-workflow fold machinery (the file-local helpers a
// dispatch handler calls); the handler itself lives in workflow-builder.ts
// (`emitEventSourcedHandlerFn`), where the shared workflow statement spine +
// repo wiring already live.  Reuses the aggregate event store's `eventToData`
// / `rowToEvent` (de)serialisers — the stream row shape is identical.
// ---------------------------------------------------------------------------

/** The event-sourced workflows in a context. */
export function eventSourcedWorkflows(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter((wf) => wf.eventSourced);
}

/** The event types a workflow folds — the events its appliers consume. */
export function foldedEventNames(wf: WorkflowIR): string[] {
  return [...new Set((wf.appliers ?? []).map((a) => a.event))];
}

/** The Drizzle stream-table const for a workflow — the single per-context
 *  `<ctx>_events` log (event-log-architecture.md), shared by every ES aggregate
 *  and ES workflow in the context and discriminated by `stream_type`.  Named
 *  after the OWNING context so a merged multi-context deployable references the
 *  same const the schema emits (`<owner>Events`). */
function streamTable(ownerName: string): string {
  return `schema.${lowerFirst(ownerName)}Events`;
}

/** `<T>State` type name. */
export function stateTypeName(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}State`;
}

/** A typed initial value for a required saga-state field at fold-from-zero —
 *  overwritten by the first applier that sets it, but needed so the state
 *  literal satisfies its type.  Mirrors the state-based saga's
 *  `defaultLiteralFor`, but typed (enum → first value, money → `new
 *  Decimal(0)`, datetime → `new Date()`). */
function initialValueFor(t: TypeIR, ctx: EnrichedBoundedContextIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive") {
    switch (inner.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "money":
        return "new Decimal(0)";
      case "bool":
        return "false";
      case "datetime":
        return "new Date()";
      case "json":
        return "{}";
      default:
        return `""`;
    }
  }
  if (inner.kind === "enum") {
    const e = ctx.enums.find((x) => x.name === inner.name);
    const first = e?.values[0];
    return first ? `"${first}"` : `""`;
  }
  if (inner.kind === "array") return "[]";
  if (inner.kind === "id") return `"" as ${tsParamType(inner)}`;
  return `""`;
}

/** Render one applier statement against the folded `state` object — the
 *  `this.<field>` seam resolves to `state.<field>` (a plain mutable record, not
 *  the aggregate's private-field class).  Applier bodies are pure (the A1
 *  discipline forbids emit / calls / I/O), so only assigns / collection
 *  mutations appear; anything else is a lowering bug and throws. */
function renderApplierStmt(s: StmtIR, indent: string): string {
  const target = (segments: readonly string[]): string => `state.${segments.join(".")}`;
  const ES = { thisName: "state" } as const;
  switch (s.kind) {
    case "assign":
      return `${indent}${target(s.target.segments)} = ${renderTsExpr(s.value, ES)};`;
    case "add":
      return `${indent}${target(s.target.segments)}.push(${renderTsExpr(s.value, ES)});`;
    case "remove": {
      const path = target(s.target.segments);
      const value = renderTsExpr(s.value, ES);
      return `${indent}{ const __i = ${path}.findIndex((e) => e === (${value})); if (__i >= 0) ${path}.splice(__i, 1); }`;
    }
    default:
      throw new Error(
        `es-workflow applier: unexpected statement kind '${s.kind}' (appliers are pure folds)`,
      );
  }
}

/** The file-local fold helpers for one event-sourced workflow:
 *    type <T>State                       — the folded saga state shape
 *    fold<T>(key, events): <T>State       — fold-from-zero through the appliers
 *    apply<T>(state, ev): void            — per-event applier dispatch
 *    load<T>Events(db, key): Events[]      — read + deserialise the stream
 *    append<T>Events(db, key, events)      — gap-free append of the own-events
 *    <T>_FOLDED_EVENTS                     — the event types this workflow folds
 *  Reads the `<wf>_events` Drizzle table the schema emitter produces.
 *
 *  `opts.readOnly` emits only the READ-side helpers (state type, apply, fold,
 *  loadAll) — the subset a workflow-sourced read model needs.  The write-side
 *  (`load<T>Events`, `append<T>Events`, `<T>_FOLDED_EVENTS`) is omitted so the
 *  read-model file stays free of dead declarations under Biome's noUnusedVariables;
 *  the dispatcher (which appends own-events) leaves it unset to get the full
 *  set.  loadAll only reaches `rowToEvent`, so a read-only consumer can pass
 *  `{ readOnly: true }` to `emitWorkflowStreamSerializers` too. */
export function emitWorkflowFoldHelpers(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  opts: { readOnly?: boolean; resolveStreamContext?: (name: string) => string | undefined } = {},
): string[] {
  const T = upperFirst(wf.name);
  const corr = wf.correlationField as string;
  // Resolve the workflow's OWNING context — `ctx` may be a merged union of
  // several contexts (multi-context deployable), so the shared `<ctx>_events`
  // log const must be named after the owner (matching the schema + migrations).
  const owner = opts.resolveStreamContext?.(wf.name) ?? ctx.name;
  const table = streamTable(owner);
  // The stream-type discriminator that carves this workflow's slice out of the
  // shared per-context event log — mirrors the ES aggregate repo's
  // `stream_type = "<Agg>"`.
  const streamType = T;
  const out: string[] = [];

  // State type — every saga state field (the correlation key + folded state).
  out.push(`type ${T}State = {`);
  for (const f of wf.stateFields ?? []) {
    const opt = f.optional || f.type.kind === "optional";
    out.push(
      `  ${f.name}${opt ? "?" : ""}: ${tsParamType(f.type.kind === "optional" ? f.type.inner : f.type)};`,
    );
  }
  out.push(`};`);

  // apply<T> — fold one event into the state (one arm per applier).
  out.push(`function apply${T}(state: ${T}State, ev: Events.DomainEvent): void {`);
  out.push(`  switch (ev.type) {`);
  for (const ap of wf.appliers ?? []) {
    out.push(`    case ${JSON.stringify(ap.event)}: {`);
    out.push(`      const ${ap.param} = ev as Events.${ap.event};`);
    out.push(`      void ${ap.param};`);
    for (const s of ap.statements) out.push(renderApplierStmt(s, "      "));
    out.push(`      break;`);
    out.push(`    }`);
  }
  out.push(`  }`);
  out.push(`}`);

  // fold<T> — fold-from-zero: seed the correlation key + typed defaults, then
  // replay the stream.
  const seeds = (wf.stateFields ?? [])
    .filter((f) => !(f.optional || f.type.kind === "optional"))
    .map((f) =>
      f.name === corr
        ? `${f.name}: key as ${tsParamType(f.type)}`
        : `${f.name}: ${initialValueFor(f.type, ctx)}`,
    );
  out.push(`function fold${T}(key: string, events: Events.DomainEvent[]): ${T}State {`);
  out.push(`  const state: ${T}State = { ${seeds.join(", ")} };`);
  out.push(`  for (const ev of events) apply${T}(state, ev);`);
  out.push(`  return state;`);
  out.push(`}`);

  // load<T>Events — read + deserialise the per-correlation stream in order.  A
  // read-only consumer never loads a single correlation stream, so skip
  // it to keep the read-model file free of dead declarations.
  if (!opts.readOnly) {
    out.push(`async function load${T}Events(`);
    out.push(`  db: NodePgDatabase<typeof schema>,`);
    out.push(`  key: string,`);
    out.push(`): Promise<Events.DomainEvent[]> {`);
    out.push(`  const rows = await db`);
    out.push(`    .select()`);
    out.push(`    .from(${table})`);
    out.push(
      `    .where(and(eq(${table}.streamType, "${streamType}"), eq(${table}.streamId, key)))`,
    );
    out.push(`    .orderBy(${table}.version);`);
    out.push(`  return rows.map((r) => rowToEvent({ type: r.type, data: r.data }));`);
    out.push(`}`);
  }

  // loadAll<T> — read every stream, group by correlation key, fold each.  The
  // instance-LIST read body (workflow-instance-visibility.md) mirrors the
  // event-sourced AGGREGATE's `_loadAll` group-fold.
  out.push(`async function loadAll${T}(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`): Promise<${T}State[]> {`);
  out.push(`  const rows = await db`);
  out.push(`    .select()`);
  out.push(`    .from(${table})`);
  out.push(`    .where(eq(${table}.streamType, "${streamType}"))`);
  out.push(`    .orderBy(${table}.streamId, ${table}.version);`);
  out.push(`  const byStream = new Map<string, Events.DomainEvent[]>();`);
  out.push(`  for (const r of rows) {`);
  out.push(`    const list = byStream.get(r.streamId) ?? [];`);
  out.push(`    list.push(rowToEvent({ type: r.type, data: r.data }));`);
  out.push(`    byStream.set(r.streamId, list);`);
  out.push(`  }`);
  out.push(`  return [...byStream.entries()].map(([id, evs]) => fold${T}(id, evs));`);
  out.push(`}`);

  if (opts.readOnly) {
    // A read-only consumer never appends own-events or inspects the folded-event set.
    return out;
  }

  // append<T>Events — gap-free append of the workflow's own (folded) events.
  out.push(`async function append${T}Events(`);
  out.push(`  db: NodePgDatabase<typeof schema>,`);
  out.push(`  key: string,`);
  out.push(`  events: Events.DomainEvent[],`);
  out.push(`): Promise<void> {`);
  out.push(`  if (events.length === 0) return;`);
  out.push(`  const prior = await db`);
  out.push(`    .select({ version: ${table}.version })`);
  out.push(`    .from(${table})`);
  out.push(
    `    .where(and(eq(${table}.streamType, "${streamType}"), eq(${table}.streamId, key)));`,
  );
  out.push(`  let version = prior.reduce((m, r) => Math.max(m, r.version), 0);`);
  out.push(`  const rows = events.map((event) => ({`);
  out.push(`    streamType: "${streamType}",`);
  out.push(`    streamId: key,`);
  out.push(`    version: ++version,`);
  out.push(`    type: event.type,`);
  out.push(`    data: eventToData(event),`);
  out.push(`  }));`);
  out.push(`  await db.insert(${table}).values(rows);`);
  out.push(`}`);

  // The event types this workflow folds (own-events appended to its stream;
  // other emitted events are choreography, re-published only).
  const folded = foldedEventNames(wf)
    .map((n) => JSON.stringify(n))
    .join(", ");
  out.push(`const ${T}_FOLDED_EVENTS: ReadonlySet<string> = new Set([${folded}]);`);

  return out;
}

/** The shared stream (de)serialisers for every event an ES workflow in this
 *  context folds — `eventToData` (domain → JSON row) + `rowToEvent` (row →
 *  tagged domain event).  Emitted once; reuses the aggregate event store's
 *  emitters over the union of folded event types. */
export function emitWorkflowStreamSerializers(
  ctx: EnrichedBoundedContextIR,
  opts: { readOnly?: boolean } = {},
): string[] {
  const folded = new Set<string>();
  for (const wf of eventSourcedWorkflows(ctx)) for (const n of foldedEventNames(wf)) folded.add(n);
  if (folded.size === 0) return [];
  const events: EventIR[] = ctx.events.filter((e) => folded.has(e.name));
  // A read-only consumer only group-folds the stream → only `rowToEvent`
  // is reached; omit `eventToData` (write-side) so the read-model file carries no
  // dead declaration.
  if (opts.readOnly) return [rowToEventFn(events, ctx)];
  return [eventToDataFn(events, ctx), "", rowToEventFn(events, ctx)];
}

/** Helper names the ES handler emitter (workflow-builder.ts) references. */
export function esHelperNames(wf: WorkflowIR): {
  fold: string;
  load: string;
  loadAll: string;
  append: string;
  foldedSet: string;
} {
  const T = upperFirst(wf.name);
  return {
    fold: `fold${T}`,
    load: `load${T}Events`,
    loadAll: `loadAll${T}`,
    append: `append${T}Events`,
    foldedSet: `${T}_FOLDED_EVENTS`,
  };
}

/** The slug used in the `event_unrouted` log (parity with the state path). */
export function workflowSlug(wf: WorkflowIR): string {
  return snake(wf.name);
}
