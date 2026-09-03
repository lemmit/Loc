// -------------------------------------------------------------------------
// Event-sourced-shape repository (append-only event stream, folded
// state).  Split out of mikroorm.ts by packet 2.6 (wave-2) — mechanical
// move, no logic change.
// -------------------------------------------------------------------------

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EventIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { synthProjectionFinds } from "../projection-finds.js";
import {
  deserializeField,
  docFieldType,
  findPredicate,
  inMemoryPagedTailLines,
  PAGED_TAIL_PARAMS,
  pagedReturnType,
  serializeField,
} from "../repository-document-builder.js";
import { repoPortImportLine, repoPortName } from "../repository-port-builder.js";
import { aggHasFieldMask, toWireMaskedMethod, toWireMethod } from "../repository-wire-builder.js";
import { eventRowClassOf } from "./mikroorm-entities.js";
import { mikroBlobGetByIdLines } from "./mikroorm-filter.js";
import { tsParamType, usesRawFragment } from "./mikroorm-shared.js";

// ---------------------------------------------------------------------------
// Event-sourced (`persistedAs: eventLog`) MikroORM repository (appliers,
// MikroORM edition).  The Hono domain fold (`_apply` / `_fromEvents`) + CQRS
// are persistence-agnostic and reused; this is the EntityManager version of
// the event store — read the `<agg>_events` stream ordered by version and fold
// via `_fromEvents`; append `pullEvents()` with gap-free versions; finds load
// every stream + fold in-memory.  Payloads round-trip through the document
// builder's field (de)serialisers.
// ---------------------------------------------------------------------------

export function renderMikroEventSourcedRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const eventRow = eventRowClassOf(ctx.name);
  // This aggregate's slice of the shared per-context event log — discriminated
  // by `stream_type = "<Agg>"` (mirrors the Drizzle ES repo).
  const streamType = agg.name;
  const streamEvents: EventIR[] = (agg.appliers ?? [])
    .map((ap) => ctx.events.find((e) => e.name === ap.event))
    .filter((e): e is EventIR => e != null);

  const eventToDataArms = streamEvents.flatMap((e) => {
    const entries = e.fields.map(
      (f) => `${f.name}: ${serializeField(f.type, `ev.${f.name}`, ctx)}`,
    );
    return [`    case ${JSON.stringify(e.name)}:`, `      return { ${entries.join(", ")} };`];
  });
  const rowToEventArms = streamEvents.flatMap((e) => {
    const entries = [
      `type: ${JSON.stringify(e.name)}`,
      ...e.fields.map((f) => `${f.name}: ${deserializeField(f.type, `d.${f.name}`, ctx)}`),
    ];
    const dType = e.fields.map((f) => `${f.name}: ${docFieldType(f.type, ctx)}`).join("; ");
    return [
      `    case ${JSON.stringify(e.name)}: {`,
      `      const d = data as { ${dType} };`,
      `      return { ${entries.join(", ")} } as Events.${e.name};`,
      "    }",
    ];
  });

  const findMethods = [...(repo?.finds ?? []), ...synthProjectionFinds(agg.name, ctx)].map(
    (find) => {
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
          : "all"
        : isOptional
          ? `all.find(${pred ?? "() => true"}) ?? null`
          : `all.find(${pred ?? "() => true"})!`;
      // `find … paged` over a stream — same in-memory page as the document blob
      // above and as the drizzle event-sourced repository (F2-CB-C1).
      if (pagedReturn(find.returnType)) {
        const pagedParams = [...baseParams, ...PAGED_TAIL_PARAMS];
        const pagedAll = (usesUser ? [...pagedParams, "currentUser: User"] : pagedParams).join(
          ", ",
        );
        return lines(
          `  async ${find.name}(${pagedAll}): Promise<${pagedReturnType(agg.name)}> {`,
          "    const all = await this._loadAll();",
          `    const matched = ${pred ? `all.filter(${pred})` : "all"};`,
          ...inMemoryPagedTailLines(agg, "matched", find.name),
          "  }",
        );
      }
      return lines(
        `  async ${find.name}(${params}): Promise<${ret}> {`,
        "    const all = await this._loadAll();",
        `    return ${selector};`,
        "  }",
      );
    },
  );

  // A find that threads `currentUser`, OR a `mask unless` field — whose
  // `toWireMasked(root, currentUser: User | null)` names `User` in its
  // signature — needs the `User` import.  The `aggHasFieldMask` half was
  // missing on every MikroORM repository variant while all four emitted
  // `toWireMaskedMethod`, so `mask unless` under `persistence: mikroorm`
  // produced TS2304 "Cannot find name 'User'" (M-T9.29, finding F3).  The
  // relational drizzle builder has always spelled the rule this way —
  // `typescript/repository-builder.ts`.
  const repoUsesUser = (repo?.finds ?? []).some(findUsesCurrentUser) || aggHasFieldMask(agg);

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    // Explicit field declarations + constructor assignments, not
    // parameter properties — see emit/value-objects.ts's renderValueObject.
    "  private readonly em: EntityManager;",
    "  private readonly events: DomainEventDispatcher;",
    "  constructor(",
    "    em: EntityManager,",
    "    events: DomainEventDispatcher,",
    "  ) {",
    "    this.em = em;",
    "    this.events = events;",
    "  }",
    "",
    `  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`,
    "    const em = this.em.fork({ keepTransactionContext: true });",
    `    const rows = await em.find(${eventRow}, { streamType: "${streamType}", streamId: id as string }, { orderBy: { version: "ASC" } });`,
    "    if (rows.length === 0) return null;",
    `    return ${agg.name}._fromEvents(`,
    "      id,",
    "      rows.map((r) => rowToEvent({ type: r.type, data: r.data })),",
    "    );",
    "  }",
    "",
    ...mikroBlobGetByIdLines(agg, `Ids.${agg.name}Id`),
    "",
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    "    if (ids.length === 0) return [];",
    `    const out: ${agg.name}[] = [];`,
    "    for (const id of ids) {",
    "      const found = await this.findById(id);",
    "      if (found) out.push(found);",
    "    }",
    "    return out;",
    "  }",
    "",
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    "    const em = this.em.fork({ keepTransactionContext: true });",
    "    const pending = aggregate.pullEvents();",
    "    if (pending.length > 0) {",
    "      const streamId = aggregate.id as string;",
    `      const prior = await em.find(${eventRow}, { streamType: "${streamType}", streamId }, { orderBy: { version: "DESC" }, limit: 1 });`,
    "      let version = prior.length > 0 ? prior[0]!.version : 0;",
    "      for (const event of pending) {",
    "        version++;",
    `        const r = new ${eventRow}();`,
    `        r.streamType = "${streamType}";`,
    "        r.streamId = streamId;",
    "        r.version = version;",
    "        r.type = event.type;",
    "        r.data = eventToData(event);",
    "        r.occurredAt = new Date();",
    "        em.persist(r);",
    "      }",
    "      await em.flush();",
    "    }",
    '    requestLog().debug({ event: "repository_save", aggregate: ' +
      JSON.stringify(agg.name) +
      ", id: aggregate.id as string });",
    "    for (const event of pending) {",
    '      requestLog().info({ event: "event_dispatched", event_type: event.type, aggregate: ' +
      JSON.stringify(agg.name) +
      ", id: aggregate.id as string });",
    "      await this.events.dispatch(event);",
    "    }",
    "  }",
    "",
    `  private async _loadAll(): Promise<${agg.name}[]> {`,
    "    const em = this.em.fork({ keepTransactionContext: true });",
    `    const rows = await em.find(${eventRow}, { streamType: "${streamType}" }, { orderBy: { streamId: "ASC", version: "ASC" } });`,
    "    const byStream = new Map<string, Events.DomainEvent[]>();",
    "    for (const r of rows) {",
    "      const list = byStream.get(r.streamId) ?? [];",
    "      list.push(rowToEvent({ type: r.type, data: r.data }));",
    "      byStream.set(r.streamId, list);",
    "    }",
    `    return [...byStream.entries()].map(([id, evs]) => ${agg.name}._fromEvents(Ids.${agg.name}Id(id), evs));`,
    "  }",
    ...findMethods.flatMap((m) => ["", m]),
    "",
    toWireMethod(agg, ctx),
    // Response-boundary read masking (`mask unless`) — the SAME sibling
    // serializer the drizzle repository emits (`repository-builder.ts`).  The
    // route handlers call `repo.toWireMasked(row, currentUser)` unconditionally
    // for a masked aggregate, on BOTH persistence adapters, so a mikroorm
    // repository that emitted only `toWire` shipped a call to a method that did
    // not exist: TypeError → 500 on every read of a masked aggregate, which is
    // the crash-shaped failure of the one feature whose quiet failure is a leak.
    // Invisible until `field-mask` got its first runtime caller (#2468).
    // Mask-free aggregates emit nothing here and stay byte-identical.
    ...(aggHasFieldMask(agg) ? ["", toWireMaskedMethod(agg)] : []),
    "}",
    "",
    "function eventToData(ev: Events.DomainEvent): Record<string, unknown> {",
    "  switch (ev.type) {",
    ...eventToDataArms,
    "    default:",
    "      return {};",
    "  }",
    "}",
    "",
    "function rowToEvent(row: { type: string; data: unknown }): Events.DomainEvent {",
    "  const data = row.data;",
    "  switch (row.type) {",
    ...rowToEventArms,
    "    default:",
    "      throw new Error(`unknown event type: ${row.type}`);",
    "  }",
    "}",
  );

  const bodyScan = body
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const candidates = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  const referenced = candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voImportLine: string | false = false;
  if (referenced.length > 0) {
    const anyValue = referenced.some(isValueUsed);
    voImportLine = anyValue
      ? `import { ${referenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${referenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const usesDecimal = /new\s+Decimal\(/.test(bodyScan);
  const usesPrincipal = /\brequireCurrentUser\(/.test(bodyScan);
  const usesRaw = usesRawFragment(bodyScan);

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      // Domain-side repository PORT this concrete implements (audit S7).
      repoPortImportLine(agg.name),
      usesPrincipal && `import { requireCurrentUser } from "../../auth/middleware";`,
      usesRaw && `import { raw } from "@mikro-orm/core";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${eventRow} } from "../entities";`,
      // The aggregate root + any contained entity parts (folded in-memory from
      // the stream) — `toWire` projects the part shapes, so their classes must
      // be in scope even though the ES store never touches a child table.
      `import { ${[agg.name, ...(agg.parts ?? []).map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      `import type * as Events from "../../domain/events";`,
      `import { AggregateNotFoundError } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      repoUsesUser && `import type { User } from "../../auth/user-types";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}
