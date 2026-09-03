// -------------------------------------------------------------------------
// Document-shape (`shape: document`) repository.  Split out of
// mikroorm.ts by packet 2.6 (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesPrincipalContextFilter,
  findUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { synthProjectionFinds } from "../projection-finds.js";
import {
  docTypeAlias,
  documentCapabilityBody,
  entityFromDocFn,
  entityToDocFn,
  findPredicate,
  inMemoryPagedTailLines,
  PAGED_TAIL_PARAMS,
  pagedReturnType,
} from "../repository-document-builder.js";
import { repoPortImportLine, repoPortName } from "../repository-port-builder.js";
import { aggHasFieldMask, toWireMaskedMethod, toWireMethod } from "../repository-wire-builder.js";
import { aggregateIsAudited } from "./audit-stamp.js";
import { mikroSaveTxLines } from "./mikroorm-config.js";
import { rowClassOf } from "./mikroorm-entities.js";
import { mikroBlobGetByIdLines } from "./mikroorm-filter.js";
import { maskUserImport, tsParamType, usesRawFragment } from "./mikroorm-shared.js";

// ---------------------------------------------------------------------------
// Document-shape (`shape: document`) MikroORM repository.  The whole aggregate
// tree collapses to ONE opaque jsonb blob (`(id, data, version)`) — the Marten-
// style end of the saving-shape spectrum.  Row ↔ domain mapping runs entirely
// through the shared `<agg>ToDoc` / `<agg>FromDoc` (de)serialisers the drizzle
// document repository uses (contained parts nest, `Id[]` references ride as id
// strings), so the wire contract is byte-identical to the drizzle document
// path.  Capability `filter`s and find predicates can't be column FilterQueries
// (every field lives in the blob), so they evaluate IN-APP over the rehydrated
// aggregates — mirroring `buildDocumentRepositoryFile`.
// ---------------------------------------------------------------------------

export function renderMikroDocumentRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassOf(agg.name);
  const idVar = `Ids.${agg.name}Id`;
  const versioned = aggregateIsVersioned(agg);
  const emitsDelete = !!agg.canonicalDestroy;
  // Root rehydrate — a versioned root takes the authoritative `version` COLUMN
  // (the blob copy lags a write), matching the drizzle document path.
  const fromDocOf = (rowVar: string): string =>
    versioned
      ? `${lowerFirst(agg.name)}FromDoc(${rowVar}.data as ${agg.name}Doc, ${rowVar}.version)`
      : `${lowerFirst(agg.name)}FromDoc(${rowVar}.data as ${agg.name}Doc)`;
  // In-app capability predicate over a rehydrated aggregate (soft-delete /
  // tenancy).  On `shape: document` the filter CANNOT be pushed into the query
  // — the row is one opaque jsonb blob — so it is evaluated over the
  // rehydrated record, and a PRINCIPAL-referencing filter therefore needs
  // `currentUser` bound in each read's scope, exactly as the drizzle document
  // builder does (`principalBind`).  Pairwise F5: this bind was missing here,
  // so every read named a free `currentUser` (TS2304).
  const capRec = documentCapabilityBody(agg, "rec");
  const capX = documentCapabilityBody(agg, "x");
  const principalBind = aggregateUsesPrincipalContextFilter(agg)
    ? `    const currentUser = requireCurrentUser();`
    : null;

  // Finds evaluate in-memory over the rehydrated read model (the read already
  // deserialises every row), narrowed first by the capability filter then by
  // the find's own predicate — same selector shape as the drizzle document
  // builder's `documentFindMethod`.
  const findMethods = [...(repo?.finds ?? []), ...synthProjectionFinds(agg.name, ctx)].map((f) => {
    // A find whose own `where` names `currentUser` gains a trailing
    // `currentUser: User` parameter — the same contract the drizzle repository
    // has, and the one every call site already assumes: the Hono route emits
    // `repo.<find>(…, currentUser)` whenever `findUsesCurrentUser` is true, so a
    // method that omitted the parameter was called with one argument too many
    // (TS2554 in the GENERATED project, which this toolchain's own `tsc` cannot
    // see).  That mismatch — not any missing accessor — is what
    // `MIKROORM_SUBSET` was really describing when it refused the shape.
    const usesUser = findUsesCurrentUser(f);
    const baseParams = f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
    const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
    const pred = findPredicate(agg, f, ctx);
    const isArray = f.returnType.kind === "array";
    const isOptional = f.returnType.kind === "optional";
    const ret = isArray ? `${agg.name}[]` : isOptional ? `${agg.name} | null` : agg.name;
    // Per-find capability predicate: the aggregate-wide `capX` above cannot see
    // THIS find's `ignoring <Cap>` / `ignoring *`, so reusing it here silently
    // re-applied a bypassed capability filter — the MikroORM twin of the
    // drizzle document defect (M-T6.51).  The relational mikro path already
    // threads the bypass (`mikroContextFilters(agg, { bypassAll, bypassCaps })`);
    // the document path now does too.
    const findCap = documentCapabilityBody(agg, "x", {
      bypassAll: f.bypassAll,
      bypassCaps: f.bypassCaps,
    });
    const allExpr = findCap ? `all.filter((x) => ${findCap})` : "all";
    const selector = isArray
      ? pred
        ? `${allExpr}.filter(${pred})`
        : allExpr
      : isOptional
        ? `${allExpr}.find(${pred ?? "() => true"}) ?? null`
        : `${allExpr}.find(${pred ?? "() => true"})!`;
    const rowsExpr = isArray ? "result.length" : "result == null ? 0 : 1";
    // A find that already takes a `currentUser: User` param reuses it; any
    // other find under a principal filter binds the ambient accessor
    // (fail-closed), matching `documentFindMethod` on the drizzle side.
    const needsPrincipalBind = principalBind !== null && !findUsesCurrentUser(f);
    const loadLines = [
      ...(needsPrincipalBind ? [principalBind] : []),
      `    const em = this.em.fork({ keepTransactionContext: true });`,
      `    const rows = await em.find(${row}, {});`,
      `    const all = rows.map((r) => ${fromDocOf("r")});`,
    ];
    // `find … paged` — no queryable columns on a document blob, so the page is
    // taken in-memory over the rehydrated list, exactly as the drizzle document
    // repository does.  Without this the route's paged contract met an unpaged
    // single-get method (F2-CB-C1).
    if (pagedReturn(f.returnType)) {
      const pagedParams = [...baseParams, ...PAGED_TAIL_PARAMS];
      const pagedAll = (usesUser ? [...pagedParams, "currentUser: User"] : pagedParams).join(", ");
      return lines(
        `  async ${f.name}(${pagedAll}): Promise<${pagedReturnType(agg.name)}> {`,
        ...loadLines,
        `    const matched = ${pred ? `${allExpr}.filter(${pred})` : allExpr};`,
        ...inMemoryPagedTailLines(agg, "matched", f.name),
        `  }`,
      );
    }
    return lines(
      `  async ${f.name}(${params}): Promise<${ret}> {`,
      ...loadLines,
      `    const result = ${selector};`,
      `    requestLog().debug({ event: "find_executed", aggregate: "${agg.name}", find: "${f.name}", rows: ${rowsExpr} });`,
      `    return result;`,
      `  }`,
    );
  });

  const docAudited = aggregateIsAudited(agg);
  const deleteMethod = emitsDelete
    ? lines(
        `  async delete(id: ${idVar}): Promise<void> {`,
        `    await this.em.fork({ keepTransactionContext: true }).nativeDelete(${row}, { id: id as string });`,
        `  }`,
      )
    : "";

  // The `onCreate` stamps land on the doc payload at INSERT, exactly as on the
  // drizzle document path (repository-document-builder.ts) and the relational
  // MikroORM path above (`em.upsert(row, stampInsert(...))`).  A document
  // aggregate is one jsonb column, so the stamped fields live INSIDE `data` —
  // same helper, same lifecycle.
  //
  // INSERT only.  `stampUpdate` STRIPS the create-only fields so a relational
  // partial update cannot overwrite them; here the whole blob is rewritten, so
  // stripping `tenantId`/`dataKey` would DELETE them from the document.  The
  // rehydrated aggregate already carries both.
  //
  // This adapter was the SIXTH emission site of one bug: a `tenantOwned`
  // document row written with an empty tenant is invisible to every principal
  // including its creator.  It surfaced only when `policy-document` gained a
  // `test e2e` — the caller runs on every behavioural leg, and the mikroorm leg
  // failed while drizzle passed.
  // Property SHORTHAND when unaudited (`data`, not `data: data`) so an
  // aggregate with no lifecycle stamps emits byte-identically to before.
  const docData = docAudited ? "data: stampInsert(data)" : "data";
  const saveLines = versioned
    ? [
        `    const expected = expectedVersion ?? aggregate.version;`,
        `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
        `    if (existing === null) {`,
        `      await em.insert(${row}, { id: aggregate.id as string, ${docData}, version: 1 });`,
        `    } else {`,
        `      const affected = await em.nativeUpdate(${row}, { id: aggregate.id as string, version: expected }, { data, version: expected + 1 });`,
        `      if (affected === 0) throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
        `    }`,
      ]
    : [
        `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
        `    if (existing === null) {`,
        `      await em.insert(${row}, { id: aggregate.id as string, ${docData}, version: 1 });`,
        `    } else {`,
        `      await em.nativeUpdate(${row}, { id: aggregate.id as string }, { data, version: existing.version + 1 });`,
        `    }`,
      ];

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    `  private readonly em: EntityManager;`,
    `  private readonly events: DomainEventDispatcher;`,
    `  constructor(`,
    `    em: EntityManager,`,
    `    events: DomainEventDispatcher,`,
    `  ) {`,
    `    this.em = em;`,
    `    this.events = events;`,
    `  }`,
    "",
    `  async findById(id: ${idVar}): Promise<${agg.name} | null> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const row = await em.findOne(${row}, { id: id as string });`,
    `    requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: !!row });`,
    `    if (row === null) return null;`,
    ...(capRec
      ? [
          ...(principalBind ? [principalBind] : []),
          `    const rec = ${fromDocOf("row")};`,
          `    if (!(${capRec})) return null;`,
          `    return rec;`,
        ]
      : [`    return ${fromDocOf("row")};`]),
    `  }`,
    "",
    ...mikroBlobGetByIdLines(agg, idVar),
    "",
    `  async findManyByIds(ids: ${idVar}[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    ...(principalBind && capX ? [principalBind] : []),
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, { id: { $in: ids as string[] } });`,
    `    return rows.map((r) => ${fromDocOf("r")})${capX ? `.filter((x) => ${capX})` : ""};`,
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    ...mikroSaveTxLines([
      `    const data = ${lowerFirst(agg.name)}ToDoc(aggregate);`,
      ...saveLines,
    ]),
    `    requestLog().debug({ event: "repository_save", aggregate: "${agg.name}", id: aggregate.id as string });`,
    "",
    `    for (const event of aggregate.pullEvents()) {`,
    `      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string });`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    deleteMethod ? "" : null,
    deleteMethod || null,
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
    `}`,
    "",
    // Document (de)serialisers — module-level so they recurse into contained
    // parts.  The root carries a `<Agg>Doc` type alias; parts carry their own.
    docTypeAlias(agg, true, agg.name, ctx),
    "",
    ...agg.parts.flatMap((p) => [docTypeAlias(p, false, agg.name, ctx), ""]),
    entityToDocFn(agg, ctx),
    "",
    ...agg.parts.flatMap((p) => [entityToDocFn(p, ctx), ""]),
    entityFromDocFn(agg, true, agg.name, ctx),
    "",
    ...agg.parts.flatMap((p) => [entityFromDocFn(p, false, agg.name, ctx), ""]),
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
      repoPortImportLine(agg.name),
      usesPrincipal && `import { requireCurrentUser } from "../../auth/middleware";`,
      usesRaw && `import { raw } from "@mikro-orm/core";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${row} } from "../entities";`,
      maskUserImport(agg, repo),
      `import { ${[agg.name, ...agg.parts.map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      versioned
        ? `import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";`
        : `import { AggregateNotFoundError } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      docAudited && `import { stampInsert } from "../audit-stamp";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}
