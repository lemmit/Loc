import type {
  EnrichedBoundedContextIR,
  EventIR,
  StmtIR,
  TypeIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { contextEventRowClassName } from "./py-columns.js";
import { renderPyExpr } from "./render-expr.js";
import { fromData, toData } from "./repository-eventsourced-builder.js";

// ---------------------------------------------------------------------------
// Event-sourced workflows on Python/FastAPI (workflow-and-applier.md A2-S5b) —
// the saga analogue of a `persistedAs(eventLog)` aggregate.  Instead of a
// mutable `<Wf>Row` correlation row, an `eventSourced` workflow persists as an
// append-only `<wf>_events` stream (keyed by the correlation field) and folds
// it through its `apply(...)` blocks on load, exactly like the aggregate event
// store (repository-eventsourced-builder.ts).
//
// Python aggregates fold against private `self._field` backing + properties,
// which doesn't fit a plain saga-state bag; so (like the Hono port) the fold
// target is a small class with PUBLIC attributes and the appliers render via a
// dedicated stmt renderer with `thisName: "state"` (target → `state.field`,
// value → `renderPyExpr(.., { thisName: "state" })`).  These helpers live in
// `app/dispatch.py` (where the handlers are); the dispatch handler's ES branch
// (dispatch-builder.ts) folds-on-load and appends own-events.
// ---------------------------------------------------------------------------

/** Event-sourced workflows in a context. */
export function eventSourcedWorkflows(workflows: readonly WorkflowIR[]): WorkflowIR[] {
  return workflows.filter((wf) => wf.eventSourced);
}

/** The shared per-context event-log row class (`<Ctx>EventRow`) an ES workflow
 *  appends its stream to — every ES aggregate + workflow in the context shares
 *  this one table, discriminated by `stream_type` (event-log-architecture.md).
 *  Named after the workflow's OWNING context: `ctx` may be a merged union of
 *  several contexts (multi-context deployable), so a bare `ctx.name` would
 *  reference the merge name instead of the row class the schema + repository
 *  emit.  `resolveStreamContext` maps the workflow back to its owner; absent →
 *  `ctx.name`, byte-identical for single-context systems. */
export function esEventRow(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  resolveStreamContext?: (name: string) => string | undefined,
): string {
  return contextEventRowClassName(resolveStreamContext?.(wf.name) ?? ctx.name);
}

/** The fold-target class name (`TallyState`). */
export function esStateClass(wf: WorkflowIR): string {
  return `${upperFirst(wf.name)}State`;
}

/** Helper fn names the dispatch handler references.  `loadAll` is consumed by
 *  the instance-LIST read route (workflow-instance-visibility.md). */
export function esFns(wf: WorkflowIR): {
  fold: string;
  load: string;
  loadAll: string;
  append: string;
} {
  const s = snake(wf.name);
  return {
    fold: `_fold_${s}`,
    load: `_load_${s}_events`,
    loadAll: `_load_all_${s}`,
    append: `_append_${s}_events`,
  };
}

/** The correlation field's id class (`OrderId`) — the stream key type. */
function corrIdClass(wf: WorkflowIR): string {
  const corr = wf.correlationField as string;
  const f = (wf.stateFields ?? []).find((x) => x.name === corr);
  const t = f && f.type.kind === "optional" ? f.type.inner : f?.type;
  if (!t || t.kind !== "id") {
    throw new Error(`python es-workflow: correlation field of '${wf.name}' must be id-typed`);
  }
  return `${t.targetName}Id`;
}

/** Python type annotation for a saga-state field (mypy --strict needs it). */
function pyStateType(t: TypeIR): string {
  if (t.kind === "optional") return `${pyStateType(t.inner)} | None`;
  if (t.kind === "id") return `${t.targetName}Id`;
  if (t.kind === "enum") return t.name;
  if (t.kind === "array") return `list[${pyStateType(t.element)}]`;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "int";
      case "decimal":
        return "float";
      case "money":
        return "Decimal";
      case "bool":
        return "bool";
      case "datetime":
        return "datetime";
      default:
        return "str";
    }
  }
  return "str";
}

/** A typed zero for a required saga-state field at fold-from-zero.  Enums are
 *  resolved separately via `esZeroFor` (which has the enum table); this handles
 *  the type-only cases. */
function esZero(t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive") {
    switch (inner.name) {
      case "int":
      case "long":
        return "0";
      case "decimal":
        return "0.0";
      case "money":
        return 'Decimal("0")';
      case "bool":
        return "False";
      case "datetime":
        return "datetime.now(UTC)";
      default:
        return '""';
    }
  }
  if (inner.kind === "array") return "[]";
  return '""';
}

/** Render one applier statement against the public `state` object — the
 *  `this.<field>` seam resolves to `state.<field>`.  Applier bodies are pure
 *  folds (A1 discipline), so only assigns / collection mutations appear. */
export function renderApplierStmt(s: StmtIR, indent: string): string {
  const target = (segments: readonly string[]): string =>
    `state.${segments.map((x) => snake(x)).join(".")}`;
  const rctx = { thisName: "state" } as const;
  switch (s.kind) {
    case "assign":
      return `${indent}${target(s.target.segments)} = ${renderPyExpr(s.value, rctx)}`;
    case "add":
      return `${indent}${target(s.target.segments)}.append(${renderPyExpr(s.value, rctx)})`;
    case "remove":
      return `${indent}${target(s.target.segments)} = [__e for __e in ${target(s.target.segments)} if __e != (${renderPyExpr(s.value, rctx)})]`;
    default:
      throw new Error(
        `python es-workflow applier: unexpected statement kind '${s.kind}' (appliers are pure folds)`,
      );
  }
}

/** The full fold block for one event-sourced workflow, emitted into
 *  `app/dispatch.py`: the `<Wf>State` class, per-applier fold functions, the
 *  `_apply_<wf>` dispatch, the `_fold_<wf>` rehydrator, the stream load/append
 *  helpers, and the (de)serialisers. */
export function esWorkflowFoldBlock(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  resolveStreamContext?: (name: string) => string | undefined,
): string {
  const T = esStateClass(wf);
  const corr = wf.correlationField as string;
  const corrId = corrIdClass(wf);
  const row = esEventRow(wf, ctx, resolveStreamContext);
  const fns = esFns(wf);
  const fields = wf.stateFields ?? [];
  const eventNames = [...new Set((wf.appliers ?? []).map((a) => a.event))];
  const foldedEvents: EventIR[] = ctx.events.filter((e) => eventNames.includes(e.name));

  // State class — public attributes, keyword __init__ (correlation + required
  // first, optionals defaulting to None).
  const required = fields.filter((f) => !(f.optional || f.type.kind === "optional"));
  const optional = fields.filter((f) => f.optional || f.type.kind === "optional");
  const initParams = [
    ...required.map((f) => `${snake(f.name)}: ${pyStateType(f.type)}`),
    ...optional.map((f) => `${snake(f.name)}: ${pyStateType(f.type)} = None`),
  ].join(", ");
  const classBlock = lines(
    `class ${T}:`,
    `    def __init__(self, *, ${initParams}) -> None:`,
    ...fields.map((f) => `        self.${snake(f.name)} = ${snake(f.name)}`),
  );

  // Per-applier fold functions (param named after the applier binding, so the
  // body's `pr.amount` refs resolve) + the isinstance dispatch.
  const applierFns = (wf.appliers ?? []).flatMap((ap) => {
    const body = ap.statements.map((s) => renderApplierStmt(s, "    "));
    return [
      `def _apply_${snake(wf.name)}_${snake(ap.event)}(state: ${T}, ${snake(ap.param)}: ${ap.event}) -> None:`,
      ...(body.length > 0 ? body : ["    pass"]),
      "",
    ];
  });
  const applyDispatch = lines(
    `def _apply_${snake(wf.name)}(state: ${T}, ev: DomainEvent) -> None:`,
    ...(wf.appliers ?? []).flatMap((ap, i) => [
      `    ${i === 0 ? "if" : "elif"} isinstance(ev, ${ap.event}):`,
      `        _apply_${snake(wf.name)}_${snake(ap.event)}(state, ev)`,
    ]),
  );

  // Fold-from-zero: seed correlation key + typed zeros for required fields.
  const seeds = [
    `${snake(corr)}=${corrId}(key)`,
    ...required
      .filter((f) => f.name !== corr)
      .map((f) => `${snake(f.name)}=${esZeroFor(f.type, ctx)}`),
  ].join(", ");
  const foldFn = lines(
    `def ${fns.fold}(key: str, events: list[DomainEvent]) -> ${T}:`,
    `    state = ${T}(${seeds})`,
    "    for ev in events:",
    `        _apply_${snake(wf.name)}(state, ev)`,
    "    return state",
  );

  // Stream load (fold input) + gap-free append of the workflow's own events.
  const loadFn = lines(
    `async def ${fns.load}(session: AsyncSession, key: str) -> list[DomainEvent]:`,
    "    rows = (",
    `        await session.execute(`,
    `            select(${row})`,
    `            .where(${row}.stream_type == "${wf.name}", ${row}.stream_id == key)`,
    `            .order_by(${row}.version)`,
    "        )",
    "    ).scalars().all()",
    `    return [_${snake(wf.name)}_row_to_event(r) for r in rows]`,
  );

  // Load-all: read every stream ordered by (stream_id, version), group by
  // stream_id, fold each — the instance-LIST read body, mirroring the
  // event-sourced aggregate repository's group-fold list.
  const loadAllFn = lines(
    `async def ${fns.loadAll}(session: AsyncSession) -> list[${T}]:`,
    "    rows = (",
    `        await session.execute(`,
    `            select(${row})`,
    `            .where(${row}.stream_type == "${wf.name}")`,
    `            .order_by(${row}.stream_id, ${row}.version)`,
    "        )",
    "    ).scalars().all()",
    "    by_stream: dict[str, list[DomainEvent]] = {}",
    "    for r in rows:",
    `        by_stream.setdefault(r.stream_id, []).append(_${snake(wf.name)}_row_to_event(r))`,
    `    return [${fns.fold}(key, evs) for key, evs in by_stream.items()]`,
  );
  const appendFn = lines(
    `async def ${fns.append}(session: AsyncSession, key: str, events: list[DomainEvent]) -> None:`,
    "    if not events:",
    "        return",
    "    prior = (",
    `        await session.execute(`,
    `            select(func.max(${row}.version)).where(`,
    `                ${row}.stream_type == "${wf.name}", ${row}.stream_id == key`,
    "            )",
    "        )",
    "    ).scalar()",
    "    version = prior or 0",
    "    for ev in events:",
    "        version += 1",
    "        await session.execute(",
    `            insert(${row}).values(`,
    `                stream_type="${wf.name}",`,
    "                stream_id=key,",
    "                version=version,",
    "                type=type(ev).type,",
    `                data=_${snake(wf.name)}_event_to_data(ev),`,
    "                occurred_at=datetime.now(UTC),",
    "            )",
    "        )",
  );

  // Codec — reuses the aggregate event store's per-field converters.
  const rowToEvent = lines(
    `def _${snake(wf.name)}_row_to_event(row: ${row}) -> DomainEvent:`,
    "    data = cast(dict[str, object], row.data)",
    ...foldedEvents.flatMap((ev, i) => [
      `    ${i === 0 ? "if" : "elif"} row.type == "${ev.name}":`,
      `        return ${ev.name}(${ev.fields.map((f) => `${snake(f.name)}=${fromData(f.name, f.type)}`).join(", ")})`,
    ]),
    `    raise ValueError(f"unknown ${wf.name} event type: {row.type}")`,
  );
  const eventToData = lines(
    `def _${snake(wf.name)}_event_to_data(ev: DomainEvent) -> dict[str, object]:`,
    ...foldedEvents.flatMap((ev, i) => [
      `    ${i === 0 ? "if" : "elif"} isinstance(ev, ${ev.name}):`,
      `        return {${ev.fields.map((f) => `"${f.name}": ${toData(`ev.${snake(f.name)}`, f.type)}`).join(", ")}}`,
    ]),
    `    raise ValueError(f"unknown event: {type(ev).__name__}")`,
  );

  return lines(
    classBlock,
    "",
    "",
    ...applierFns,
    applyDispatch,
    "",
    "",
    foldFn,
    "",
    "",
    loadFn,
    "",
    "",
    loadAllFn,
    "",
    "",
    appendFn,
    "",
    "",
    rowToEvent,
    "",
    "",
    eventToData,
  );
}

/** A typed zero, resolving enum to its first declared value (needs ctx). */
function esZeroFor(t: TypeIR, ctx: EnrichedBoundedContextIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "enum") {
    const e = ctx.enums.find((x) => x.name === inner.name);
    const first = e?.values[0];
    return first ? `${inner.name}.${first}` : `cast(${inner.name}, "")`;
  }
  return esZero(t);
}
