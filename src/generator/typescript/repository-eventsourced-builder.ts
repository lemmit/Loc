import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EventIR,
  FindIR,
  RepositoryIR,
} from "../../ir/types/loom-ir.js";
import { aggregateUsesMoneyDeep, findUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import {
  deserializeField,
  docFieldType,
  findPredicate,
  serializeField,
  tsParamType,
} from "./repository-document-builder.js";
import { collectEnums, collectValueObjects } from "./repository-imports-builder.js";
import { toWireMethod } from "./repository-wire-builder.js";

// ---------------------------------------------------------------------------
// Event-sourced (`persistedAs(eventLog)`) repository for the Hono/Drizzle
// backend (appliers A2, fold-from-zero MVP).
//
// The aggregate's truth is its event stream — one append-only
// `<agg>_events` table keyed by `(stream_id, version)`.  There is no state
// table: state is reconstructed by folding the stream through the
// aggregate's appliers (`Agg._fromEvents(id, events)`).
//
//   - `findById` reads the stream in version order and folds it.
//   - `save` appends the aggregate's pending events (`pullEvents()`) with
//     gap-free versions continuing the stream, then dispatches them.
//   - `findAll` / repo finds load every stream, fold each, and filter
//     in-memory (MVP — no projection/read-model yet).
//
// Event payloads round-trip through the same field (de)serialisers the
// document repository uses; `toWire` is reused unchanged (it reads the
// rehydrated domain instance's getters, so the wire contract matches the
// state-based and document paths).
// ---------------------------------------------------------------------------

export function buildEventSourcedRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  _emitTrace = false,
): string {
  const idVar = `Ids.${agg.name}Id`;
  const table = `${lowerFirst(agg.name)}Events`;
  const repoUsesUser = (repo?.finds ?? []).some(findUsesCurrentUser);

  // Every event type that can appear in this aggregate's stream — the
  // events its appliers fold.  Looked up in the context for field types.
  const streamEvents: EventIR[] = (agg.appliers ?? [])
    .map((ap) => ctx.events.find((e) => e.name === ap.event))
    .filter((e): e is EventIR => e != null);

  const findMethods = (repo?.finds ?? []).map((find) => eventSourcedFindMethod(agg, find, ctx));

  const bodyStr = lines(
    `export class ${agg.name}Repository {`,
    `  constructor(`,
    `    private readonly db: Db,`,
    `    private readonly events: DomainEventDispatcher,`,
    `  ) {}`,
    "",
    `  async findById(id: ${idVar}): Promise<${agg.name} | null> {`,
    `    const rows = await this.db`,
    `      .select()`,
    `      .from(schema.${table})`,
    `      .where(eq(schema.${table}.streamId, id as string))`,
    `      .orderBy(schema.${table}.version);`,
    `    ${renderHonoStoreLogCall("aggregateLoaded", `aggregate: "${agg.name}", id: id as string, found: rows.length > 0`)}`,
    `    if (rows.length === 0) return null;`,
    `    return ${agg.name}._fromEvents(`,
    `      id,`,
    `      rows.map((r) => rowToEvent({ type: r.type, data: r.data })),`,
    `    );`,
    `  }`,
    "",
    `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
    "",
    `  async findManyByIds(ids: ${idVar}[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const out: ${agg.name}[] = [];`,
    `    for (const id of ids) {`,
    `      const found = await this.findById(id);`,
    `      if (found) out.push(found);`,
    `    }`,
    `    return out;`,
    `  }`,
    "",
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const pending = aggregate.pullEvents();`,
    `    if (pending.length > 0) {`,
    `      const prior = await this.db`,
    `        .select({ version: schema.${table}.version })`,
    `        .from(schema.${table})`,
    `        .where(eq(schema.${table}.streamId, aggregate.id as string));`,
    `      let version = prior.reduce((m, r) => Math.max(m, r.version), 0);`,
    `      const rows = pending.map((event) => ({`,
    `        streamId: aggregate.id as string,`,
    `        version: ++version,`,
    `        type: event.type,`,
    `        data: eventToData(event),`,
    `      }));`,
    // The `(stream_id, version)` PK IS this stream's optimistic-concurrency
    // control: a competing append that read the same `max(version)` inserts
    // the same version and loses the race with a Postgres unique-violation
    // (SQLSTATE 23505).  Map it to `ConcurrencyError` → 409 (the shared
    // `onError` arm), mirroring the `versioned` guarded write's stale-write
    // rejection.  The pg driver surfaces `.code === "23505"` (same shape the
    // routes `onError` uses for the `unique (...)` arm).
    `      try {`,
    `        await this.db.insert(schema.${table}).values(rows);`,
    `      } catch (err) {`,
    `        if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {`,
    `          throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
    `        }`,
    `        throw err;`,
    `      }`,
    `    }`,
    `    ${renderHonoStoreLogCall("repositorySave", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    `    for (const event of pending) {`,
    `      ${renderHonoStoreLogCall("eventDispatched", `event_type: event.type, aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    "",
    `  private async _loadAll(): Promise<${agg.name}[]> {`,
    `    const rows = await this.db`,
    `      .select()`,
    `      .from(schema.${table})`,
    `      .orderBy(schema.${table}.streamId, schema.${table}.version);`,
    `    const byStream = new Map<string, Events.DomainEvent[]>();`,
    `    for (const r of rows) {`,
    `      const list = byStream.get(r.streamId) ?? [];`,
    `      list.push(rowToEvent({ type: r.type, data: r.data }));`,
    `      byStream.set(r.streamId, list);`,
    `    }`,
    `    return [...byStream.entries()].map(([id, evs]) => ${agg.name}._fromEvents(${idVar}(id), evs));`,
    `  }`,
    "",
    ...findMethods.flatMap((m) => [m, ""]),
    toWireMethod(agg, ctx),
    "",
    `}`,
    "",
    // Stream (de)serialisers — module-level switch over the event types
    // this aggregate folds.  `eventToData` strips the `type` tag and
    // serialises domain values to JSON; `rowToEvent` rebuilds the tagged,
    // domain-typed event the appliers consume.
    eventToDataFn(streamEvents, ctx),
    "",
    rowToEventFn(streamEvents, ctx),
  );

  // Import narrowing — mirror buildRepositoryFile / the document builder so
  // the header stays free of dead names (generated-code Biome gate).
  const bodyScan = bodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const voOrEnumImports = [...collectValueObjects(agg, ctx), ...collectEnums(agg, ctx)];
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  const voOrEnumReferenced = voOrEnumImports.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  let voOrEnumImportLine: string | false = false;
  if (voOrEnumReferenced.length > 0) {
    const anyValue = voOrEnumReferenced.some(isValueUsed);
    voOrEnumImportLine = anyValue
      ? `import { ${voOrEnumReferenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${voOrEnumReferenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const domainImports = [agg.name].join(", ");

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    aggregateUsesMoneyDeep(agg, ctx.valueObjects) && `import Decimal from "decimal.js";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import { eq } from "drizzle-orm";`,
    `import * as schema from "../schema";`,
    repoUsesUser && `import type { User } from "../../auth/user-types";`,
    `import { ${domainImports} } from "../../domain/${lowerFirst(agg.name)}";`,
    voOrEnumImportLine,
    `import * as Ids from "../../domain/ids";`,
    `import type * as Events from "../../domain/events";`,
    `import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";`,
    `import type { DomainEventDispatcher } from "../../domain/events";`,
    `import { requestLog } from "../../obs/als";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    "",
    bodyStr,
    "",
  );
}

// --- finds (in-memory over the folded streams) ----------------------------

function eventSourcedFindMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const usesUser = findUsesCurrentUser(find);
  const baseParams = find.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
  const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
  const pred = findPredicate(agg, find, ctx);
  const isArray = find.returnType.kind === "array";
  const isOptional = find.returnType.kind === "optional";
  const ret = isArray ? `${agg.name}[]` : isOptional ? `${agg.name} | null` : agg.name;
  const selector = isArray
    ? pred
      ? `all.filter(${pred})`
      : `all`
    : isOptional
      ? `all.find(${pred ?? "() => true"}) ?? null`
      : `all.find(${pred ?? "() => true"})!`;
  const rowsExpr = isArray ? "result.length" : "result == null ? 0 : 1";
  return lines(
    `  async ${find.name}(${params}): Promise<${ret}> {`,
    `    const all = await this._loadAll();`,
    `    const result = ${selector};`,
    `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: ${rowsExpr}`)}`,
    `    return result;`,
    `  }`,
  );
}

// --- stream (de)serialisers -----------------------------------------------

export function eventToDataFn(events: EventIR[], ctx: EnrichedBoundedContextIR): string {
  const arms = events.flatMap((e) => {
    const entries = e.fields.map(
      (f) => `${f.name}: ${serializeField(f.type, `ev.${f.name}`, ctx)}`,
    );
    return [`    case ${JSON.stringify(e.name)}:`, `      return { ${entries.join(", ")} };`];
  });
  return lines(
    `function eventToData(ev: Events.DomainEvent): Record<string, unknown> {`,
    `  switch (ev.type) {`,
    ...arms,
    `    default:`,
    `      return {};`,
    `  }`,
    `}`,
  );
}

export function rowToEventFn(events: EventIR[], ctx: EnrichedBoundedContextIR): string {
  const arms = events.flatMap((e) => {
    const entries = [
      `type: ${JSON.stringify(e.name)}`,
      ...e.fields.map((f) => `${f.name}: ${deserializeField(f.type, `d.${f.name}`, ctx)}`),
    ];
    const dType = e.fields.map((f) => `${f.name}: ${docFieldType(f.type, ctx)}`).join("; ");
    return [
      `    case ${JSON.stringify(e.name)}: {`,
      `      const d = data as { ${dType} };`,
      `      return { ${entries.join(", ")} } as Events.${e.name};`,
      `    }`,
    ];
  });
  return lines(
    `function rowToEvent(row: { type: string; data: unknown }): Events.DomainEvent {`,
    `  const data = row.data;`,
    `  switch (row.type) {`,
    ...arms,
    `    default:`,
    `      throw new Error(\`unknown event type: \${row.type}\`);`,
    `  }`,
    `}`,
  );
}
