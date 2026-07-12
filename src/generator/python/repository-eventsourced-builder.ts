import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EventIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { contextEventRowClassName } from "./py-columns.js";
import { wireHelperImport } from "./py-type-imports.js";
import { renderPyExpr } from "./render-expr.js";
import { emittableFinds, findExecutedLine, writeGuardAlias } from "./repository-builder.js";

// ---------------------------------------------------------------------------
// Event-sourced repository — `persistedAs(eventLog)` aggregates persist
// to an append-only `<agg>_events` stream keyed by (stream_id, version);
// there is no state table (fold-from-zero MVP, parity with Hono/.NET):
//
//   - find_by_id reads the stream in version order, maps rows to event
//     dataclasses, folds via `<Agg>._from_events`.
//   - save appends the pulled events with gap-free versions continuing
//     the stream, dispatching each.
//   - all() scans (stream_id, version)-ordered and folds per stream.
//   - finds filter the folded aggregates in memory (no state columns
//     to query — the documented eventLog trade).
// ---------------------------------------------------------------------------

export function buildPyEventSourcedRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  // The single per-context event log (event-log-architecture.md); this
  // aggregate's stream is the subset tagged `stream_type = "<Agg>"`, so every
  // read filters on it and every append stamps it — two aggregates sharing one
  // table must each fold only their own events.
  const row = contextEventRowClassName(ctx.name);
  const events = (agg.appliers ?? [])
    .map((ap) => ctx.events.find((ev) => ev.name === ap.event))
    .filter((ev): ev is EventIR => ev != null);

  const body = lines(
    `class ${agg.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: ${agg.name}Id) -> ${agg.name} | None:`,
    "        rows = (",
    "            await self._session.execute(",
    `                select(${row})
                .where(${row}.stream_type == "${agg.name}", ${row}.stream_id == id)
                .order_by(${row}.version)`,
    "            )",
    "        ).scalars().all()",
    "        if not rows:",
    "            return None",
    `        return ${agg.name}._from_events(id, [self._row_to_event(row) for row in rows])`,
    "",
    `    async def get_by_id(self, id: ${agg.name}Id) -> ${agg.name}:`,
    "        found = await self.find_by_id(id)",
    `        log("debug", "aggregate_loaded", aggregate=${JSON.stringify(agg.name)}, id=str(id), found=found is not None)`,
    "        if found is None:",
    `            raise AggregateNotFoundError(f"${agg.name} {id} not found")`,
    "        return found",
    ...writeGuardAlias(agg),
    "",
    `    async def all(self) -> list[${agg.name}]:`,
    "        rows = (",
    "            await self._session.execute(",
    `                select(${row})
                .where(${row}.stream_type == "${agg.name}")
                .order_by(${row}.stream_id, ${row}.version)`,
    "            )",
    "        ).scalars().all()",
    "        by_stream: dict[str, list[DomainEvent]] = {}",
    "        for row_ in rows:",
    "            by_stream.setdefault(str(row_.stream_id), []).append(self._row_to_event(row_))",
    "        return [",
    `            ${agg.name}._from_events(${agg.name}Id(sid), evs) for sid, evs in by_stream.items()`,
    "        ]",
    ...emittableFinds(repo).flatMap((f) => ["", inMemoryFind(agg, f)]),
    "",
    `    async def save(self, aggregate: ${agg.name}) -> None:`,
    "        pending = aggregate.pull_events()",
    "        if pending:",
    "            prior = (",
    "                await self._session.execute(",
    `                    select(func.max(${row}.version)).where(
                        ${row}.stream_type == "${agg.name}", ${row}.stream_id == aggregate.id
                    )`,
    "                )",
    "            ).scalar()",
    "            version = prior or 0",
    "            for ev in pending:",
    "                version += 1",
    // The (stream_id, version) PK IS the event stream's optimistic-concurrency
    // control: a competing append that read the same max(version) inserts the
    // same version and loses with a Postgres unique_violation (SQLSTATE 23505).
    // Map it to ConcurrencyError → 409 (parity with the `versioned` guarded
    // write); asyncpg exposes `.sqlstate` on the `.orig` driver error.
    "                try:",
    "                    await self._session.execute(",
    `                        insert(${row}).values(`,
    `                            stream_type="${agg.name}",`,
    "                            stream_id=aggregate.id,",
    "                            version=version,",
    "                            type=type(ev).type,",
    "                            data=self._event_to_data(ev),",
    "                            occurred_at=datetime.now(UTC),",
    "                        )",
    "                    )",
    "                except IntegrityError as err:",
    '                    if getattr(getattr(err, "orig", None), "sqlstate", None) == "23505":',
    `                        raise ConcurrencyError(f"${agg.name} {aggregate.id} was modified concurrently") from err`,
    "                    raise",
    "                await self._events.dispatch(ev)",
    "        await self._session.flush()",
    `        log("debug", "repository_save", aggregate=${JSON.stringify(agg.name)}, id=str(aggregate.id))`,
    "",
    rowToEvent(agg, events, row),
    "",
    eventToData(events),
    "",
    toWireStub(agg, ctx),
  );

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  return lines(
    `"""${agg.name} event-store repository.  Auto-generated."""`,
    "",
    refersTo("math") ? "import math" : null,
    // A5 temporal — in-memory find filters over rehydrated instances may
    // reach for `timedelta`; UTC + datetime are always used (the
    // event-store `at` stamp).
    `from datetime import UTC, datetime${refersTo("timedelta") ? ", timedelta" : ""}`,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    "from typing import cast",
    "",
    "from sqlalchemy import func, select",
    "from sqlalchemy.dialects.postgresql import insert",
    "from sqlalchemy.exc import IntegrityError",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    `from app.db.schema import ${row}`,
    wireHelperImport(refersTo),
    "from app.domain.errors import AggregateNotFoundError, ConcurrencyError",
    `from app.domain.events import ${["DomainEvent", "DomainEventDispatcher", ...events.map((e) => e.name)].join(", ")}`,
    `from app.domain.ids import ${[...new Set([`${agg.name}Id`, ...idNamesOf(events)])].sort().join(", ")}`,
    `from app.domain.${snake(agg.name)} import ${agg.name}`,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    // `log` for the mechanism-debug trio (aggregate_loaded / repository_save /
    // find_executed) — always emitted now (S5).
    "from app.obs.log import log",
    "",
    "",
    body,
    "",
  );
}

function idNamesOf(events: EventIR[]): string[] {
  const out = new Set<string>();
  for (const ev of events) {
    for (const f of ev.fields) {
      const t = f.type.kind === "optional" ? f.type.inner : f.type;
      if (t.kind === "id") out.add(`${t.targetName}Id`);
    }
  }
  return [...out];
}

/** In-memory find over the folded aggregates — eventLog has no state
 *  columns to query. */
function inMemoryFind(agg: EnrichedAggregateIR, find: FindIR): string {
  const params = find.params.map((p) => `${snake(p.name)}: ${pyParam(p.type)}`);
  const sig = ["self", ...params].join(", ");
  const pred = find.filter ? renderPyExpr(find.filter, { thisName: "a" }) : "True";
  if (find.returnType.kind === "array") {
    return lines(
      `    async def ${snake(find.name)}(${sig}) -> list[${agg.name}]:`,
      `        result = [a for a in await self.all() if ${pred}]`,
      findExecutedLine(agg, find.name, "len(result)"),
      "        return result",
    );
  }
  return lines(
    `    async def ${snake(find.name)}(${sig}) -> ${agg.name} | None:`,
    `        matches = [a for a in await self.all() if ${pred}]`,
    findExecutedLine(agg, find.name, "len(matches)"),
    "        return matches[0] if matches else None",
  );
}

function pyParam(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name === "int" || t.name === "long"
        ? "int"
        : t.name === "bool"
          ? "bool"
          : t.name === "decimal"
            ? "float"
            : "str";
    case "id":
      return `${t.targetName}Id`;
    case "enum":
      return t.name;
    default:
      return "str";
  }
}

/** Stream row → event dataclass (wire keys are the DSL spellings). */
function rowToEvent(agg: EnrichedAggregateIR, events: EventIR[], row: string): string {
  const arms = events.flatMap((ev, i) => [
    `        ${i === 0 ? "if" : "elif"} row.type == "${ev.name}":`,
    `            return ${ev.name}(${ev.fields
      .map((f) => `${snake(f.name)}=${fromData(f.name, f.type)}`)
      .join(", ")})`,
  ]);
  return lines(
    `    def _row_to_event(self, row: ${row}) -> DomainEvent:`,
    "        data = cast(dict[str, object], row.data)",
    ...(arms.length > 0 ? arms : []),
    `        raise ValueError(f"unknown ${agg.name} event type: {row.type}")`,
  );
}

export function fromData(name: string, t: TypeIR): string {
  const access = `data["${name}"]`;
  const inner = t.kind === "optional" ? t.inner : t;
  switch (inner.kind) {
    case "primitive":
      switch (inner.name) {
        case "int":
        case "long":
          return `cast(int, ${access})`;
        case "decimal":
          return `float(cast("int | float", ${access}))`;
        case "money":
          return `Decimal(cast(str, ${access}))`;
        case "bool":
          return `cast(bool, ${access})`;
        case "datetime":
          return `datetime.fromisoformat(cast(str, ${access}))`;
        default:
          return `cast(str, ${access})`;
      }
    case "id":
      return `${inner.targetName}Id(cast(str, ${access}))`;
    case "enum":
      return `${inner.name}(cast(str, ${access}))`;
    default:
      return `cast(str, ${access})`;
  }
}

/** Event dataclass → the JSONB payload (DSL-keyed, JSON-safe values). */
function eventToData(events: EventIR[]): string {
  const arms = events.flatMap((ev, i) => [
    `        ${i === 0 ? "if" : "elif"} isinstance(ev, ${ev.name}):`,
    `            return {${ev.fields.map((f) => `"${f.name}": ${toData(`ev.${snake(f.name)}`, f.type)}`).join(", ")}}`,
  ]);
  return lines(
    "    def _event_to_data(self, ev: DomainEvent) -> dict[str, object]:",
    ...(arms.length > 0 ? arms : []),
    `        raise ValueError(f"unknown event: {type(ev).__name__}")`,
  );
}

export function toData(expr: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "primitive" && inner.name === "datetime") return `${expr}.isoformat()`;
  if (inner.kind === "primitive" && inner.name === "money") return `str(${expr})`;
  return expr;
}

/** Wire projection over the FOLDED aggregate — same canonical shape the
 *  state-based repos project (the wire contract is persistence-
 *  agnostic), reusing the shared builder via a tiny local import would
 *  recreate a cycle, so the routes layer calls this method exactly like
 *  the state repos'. */
function toWireStub(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  // The wire shape of an eventLog aggregate: id + properties + derived
  // (no containments — eventLog v1 gates parts off at the validator).
  const pairs: string[] = [`"id": root.id`];
  for (const wf of agg.wireShape) {
    if (wf.source === "id" || wf.source === "containment") continue;
    const access = `root.${snake(wf.name)}`;
    const inner = wf.type.kind === "optional" ? wf.type.inner : wf.type;
    if (inner.kind === "primitive" && inner.name === "datetime") {
      pairs.push(`"${wf.name}": iso(${access})`);
      continue;
    }
    if (inner.kind === "primitive" && inner.name === "money") {
      // Precise-decimal string on the wire (parity with the other backends).
      pairs.push(`"${wf.name}": money_str(${access})`);
      continue;
    }
    if (inner.kind === "valueobject") {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (vo) {
        const fields = vo.fields
          .map((vf) => `"${vf.name}": ${access}.${snake(vf.name)}`)
          .join(", ");
        pairs.push(`"${wf.name}": {${fields}}`);
        continue;
      }
    }
    pairs.push(`"${wf.name}": ${access}`);
  }
  return lines(
    `    def to_wire(self, root: ${agg.name}) -> dict[str, object]:`,
    "        return {",
    pairs.map((p) => `            ${p},`),
    "        }",
  );
}
