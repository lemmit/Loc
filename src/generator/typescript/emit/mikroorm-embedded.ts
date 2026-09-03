// -------------------------------------------------------------------------
// Embedded-shape (`shape: embedded`, a single jsonb column) repository.
// Split out of mikroorm.ts by packet 2.6 (wave-2) — mechanical move, no
// logic change.
// -------------------------------------------------------------------------

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { sortableFields } from "../../../ir/util/sortable-fields.js";
import { isValueCollectionType } from "../../../ir/util/value-collections.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { synthProjectionFinds } from "../projection-finds.js";
import { isRefCollection } from "../repository-associations-builder.js";
import {
  deserializeField,
  docTypeAlias,
  entityFromDocFn,
  entityToDocFn,
  serializeField,
} from "../repository-document-builder.js";
import { hydrateRootExpr } from "../repository-find-builder.js";
import { repoPortImportLine, repoPortName } from "../repository-port-builder.js";
import { projectFieldEntries } from "../repository-save-builder.js";
import { aggHasFieldMask, toWireMaskedMethod, toWireMethod } from "../repository-wire-builder.js";
import { aggregateIsAudited } from "./audit-stamp.js";
import { mikroSaveTxLines } from "./mikroorm-config.js";
import { rowClassOf } from "./mikroorm-entities.js";
import {
  AMBIENT_PRINCIPAL,
  mikroContextFilters,
  mikroGetByIdLines,
  whereToMikroFilter,
  withContextFilters,
} from "./mikroorm-filter.js";
import { valueCollFieldsOf } from "./mikroorm-relational.js";
import { maskUserImport, tsParamType, usesRawFragment } from "./mikroorm-shared.js";

// ---------------------------------------------------------------------------
// Embedded-shape (`shape: embedded`) MikroORM repository.  The queryable
// middle of the saving-shape spectrum: the aggregate ROOT stays real columns
// (hydrated/saved like the relational path), while each CONTAINMENT folds into
// one jsonb column — (de)serialised through the shared `<part>ToDoc` /
// `<part>FromDoc` helpers the document repository uses.  No child tables.
// ---------------------------------------------------------------------------

/** Per-containment local-const decls that materialise the jsonb columns into
 *  part instances, named `<c.name>` so `hydrateRootExpr`'s bare-name refs
 *  resolve.  Also materialises each `Id[]` reference collection from its folded
 *  jsonb id-string array (re-branded to the target id), the embedded analogue of
 *  the relational pivot-table load and the mirror of the drizzle embedded
 *  `hydrateLocals` ref-collection branch. */

function embeddedHydrateLocals(
  agg: EnrichedAggregateIR,
  rowVar: string,
  indent: string,
  ctx: EnrichedBoundedContextIR,
): string[] {
  const out: string[] = [];
  for (const f of agg.fields) {
    if (f.type.kind !== "array" || f.type.element.kind !== "id") continue;
    const target = f.type.element.targetName;
    out.push(
      `${indent}const ${f.name} = ((${rowVar}.${f.name} ?? []) as string[]).map((s) => Ids.${target}Id(s));`,
    );
  }
  // Value-object collections (`<VO>[]`) fold onto an inline jsonb column, so
  // deserialise each into its `<field>` local (the embedded analogue of the
  // relational `valueCollRowDeclLines`).
  for (const f of valueCollFieldsOf(agg)) {
    out.push(`${indent}const ${f.name} = ${deserializeField(f.type, `${rowVar}.${f.name}`, ctx)};`);
  }
  for (const c of agg.contains) {
    const fromDoc = `${lowerFirst(c.partName)}FromDoc`;
    if (c.collection)
      out.push(
        `${indent}const ${c.name} = ((${rowVar}.${c.name} ?? []) as ${c.partName}Doc[]).map((x) => ${fromDoc}(x));`,
      );
    else if (c.optional)
      out.push(
        `${indent}const ${c.name} = ${rowVar}.${c.name} == null ? null : ${fromDoc}(${rowVar}.${c.name} as ${c.partName}Doc);`,
      );
    else
      out.push(`${indent}const ${c.name} = ${fromDoc}(${rowVar}.${c.name} as ${c.partName}Doc);`);
  }
  return out;
}

export function renderMikroEmbeddedRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassOf(agg.name);
  const idVar = `Ids.${agg.name}Id`;
  const baseFilters = mikroContextFilters(agg);
  const scalarFields = agg.fields.filter(
    (f) => !isRefCollection(f.type) && !isValueCollectionType(f.type),
  );

  // Root save row: id + scalar column projection + one jsonb id-string array
  // per `Id[]` reference collection (folded onto the root, no pivot table) +
  // one jsonb array per value-object collection (serialised through the shared
  // `serializeField`) + one jsonb entry per containment (via `<part>ToDoc`).
  const rootEntries: string[] = ["id: aggregate.id as string"];
  for (const f of scalarFields)
    for (const e of projectFieldEntries(f, "aggregate", ctx))
      rootEntries.push(`${e.fieldName}: ${e.expr}`);
  for (const f of agg.fields)
    if (isRefCollection(f.type))
      rootEntries.push(`${f.name}: aggregate.${f.name}.map((x) => x as string)`);
  for (const f of valueCollFieldsOf(agg))
    rootEntries.push(`${f.name}: ${serializeField(f.type, `aggregate.${f.name}`, ctx)}`);
  for (const c of agg.contains) {
    const toDoc = `${lowerFirst(c.partName)}ToDoc`;
    if (c.collection) rootEntries.push(`${c.name}: aggregate.${c.name}.map((e) => ${toDoc}(e))`);
    else if (c.optional)
      rootEntries.push(
        `${c.name}: aggregate.${c.name} == null ? null : ${toDoc}(aggregate.${c.name})`,
      );
    else rootEntries.push(`${c.name}: ${toDoc}(aggregate.${c.name}!)`);
  }
  const rootRow = `{ ${rootEntries.join(", ")} }`;

  const audited = aggregateIsAudited(agg);
  const upsertCall = audited
    ? `    await em.upsert(${row}, stampInsert(rootRow));`
    : `    await em.upsert(${row}, rootRow);`;

  // Versioned optimistic-concurrency save (M-T3.4, default-on via `crudish`) —
  // the embedded analogue of the relational `versionedSaveLines` and the drizzle
  // embedded builder's guarded write.  `rootEntries` already carries `version:
  // aggregate.version` (a projected field); the guarded path drops it and stamps
  // the CAS value itself (1 on insert, expected + 1 on the update).  A
  // non-versioned embedded aggregate keeps the byte-identical bare upsert.
  const versioned = aggregateIsVersioned(agg);
  const rootEntriesNoVersion = rootEntries.filter((e) => !e.startsWith("version:"));
  const rootRowInsert = `{ ${rootEntriesNoVersion.join(", ")}, version: 1 }`;
  const rootRowUpdate = `{ ${rootEntriesNoVersion.join(", ")}, version: expected + 1 }`;
  const insertValues = audited ? `stampInsert(${rootRowInsert})` : rootRowInsert;
  const updateSet = audited ? `stampUpdate(${rootRowUpdate})` : rootRowUpdate;
  const versionedSaveLines = [
    `    const expected = expectedVersion ?? aggregate.version;`,
    `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
    `    if (existing === null) {`,
    `      await em.insert(${row}, ${insertValues});`,
    `    } else {`,
    `      const affected = await em.nativeUpdate(${row}, { id: aggregate.id as string, version: expected }, ${updateSet});`,
    `      if (affected === 0) throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
    `    }`,
  ];

  const dbg = (find: string, rowsExpr: string) =>
    `    requestLog().debug({ event: "find_executed", aggregate: "${agg.name}", find: "${find}", rows: ${rowsExpr} });`;

  const findMethods = [...(repo?.finds ?? []), ...synthProjectionFinds(agg.name, ctx)].map((f) => {
    const name = lowerFirst(f.name);
    const paged = pagedReturn(f.returnType);
    const isList = f.returnType.kind === "array";
    const ret = isList ? `${agg.name}[]` : `${agg.name} | null`;
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
    let filter: string;
    try {
      const caps = mikroContextFilters(agg, { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps });
      // The find's OWN predicate reads the declared `currentUser` parameter;
      // the capability filters (`caps`) keep the ambient accessor, because they
      // ride reads that have no such parameter.
      filter = withContextFilters(
        f.filter
          ? whereToMikroFilter(f.filter, usesUser ? "currentUser" : AMBIENT_PRINCIPAL)
          : "{}",
        caps,
      );
    } catch {
      return lines(
        `  async ${name}(${paged ? `${params}${params ? ", " : ""}page: number, pageSize: number, sort: string, dir: string` : params}): Promise<${paged ? `{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }` : ret}> {`,
        `    throw new Error("mikroorm v1: this find's predicate is not yet supported");`,
        `  }`,
      );
    }
    if (paged) {
      const pagedParams = [
        ...baseParams,
        ...(usesUser ? ["currentUser: User"] : []),
        "page: number",
        "pageSize: number",
        "sort: string",
        "dir: string",
      ].join(", ");
      const sortable = sortableFields(agg)
        .map((s) => JSON.stringify(s))
        .join(", ");
      return lines(
        `  async ${name}(${pagedParams}): Promise<{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const sortable = new Set<string>([${sortable}]);`,
        `    const sortField = sortable.has(sort) ? sort : "id";`,
        `    const orderBy: Record<string, "asc" | "desc"> = { [sortField]: dir === "desc" ? "desc" : "asc" };`,
        `    const total = await em.count(${row}, ${filter});`,
        `    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;`,
        `    const rows = await em.find(${row}, ${filter}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy });`,
        dbg(f.name, "rows.length"),
        `    const items = rows.map((row) => {`,
        ...embeddedHydrateLocals(agg, "row", "      ", ctx),
        `      return ${hydrateRootExpr(agg, "row", ctx)};`,
        `    });`,
        `    return { items, page, pageSize, total, totalPages };`,
        `  }`,
      );
    }
    if (isList) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name}[]> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const rows = await em.find(${row}, ${filter});`,
        dbg(f.name, "rows.length"),
        `    return rows.map((row) => {`,
        ...embeddedHydrateLocals(agg, "row", "      ", ctx),
        `      return ${hydrateRootExpr(agg, "row", ctx)};`,
        `    });`,
        `  }`,
      );
    }
    return lines(
      `  async ${name}(${params}): Promise<${agg.name} | null> {`,
      `    const em = this.em.fork({ keepTransactionContext: true });`,
      `    const row = await em.findOne(${row}, ${filter});`,
      `    if (row === null) return null;`,
      ...embeddedHydrateLocals(agg, "row", "    ", ctx),
      `    return ${hydrateRootExpr(agg, "row", ctx)};`,
      `  }`,
    );
  });

  const deleteMethod = agg.canonicalDestroy
    ? lines(
        `  async delete(id: ${idVar}): Promise<void> {`,
        `    await this.em.fork({ keepTransactionContext: true }).nativeDelete(${row}, ${withContextFilters("{ id: id as string }", [])});`,
        `  }`,
      )
    : "";

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
    `    const row = await em.findOne(${row}, ${withContextFilters("{ id: id as string }", baseFilters)});`,
    `    if (row === null) {`,
    `      requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: false });`,
    `      return null;`,
    `    }`,
    ...embeddedHydrateLocals(agg, "row", "    ", ctx),
    `    const loaded = ${hydrateRootExpr(agg, "row", ctx)};`,
    `    requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: true });`,
    `    return loaded;`,
    `  }`,
    "",
    ...mikroGetByIdLines(agg, idVar, row),
    "",
    `  async findManyByIds(ids: ${idVar}[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, ${withContextFilters("{ id: { $in: ids as string[] } }", baseFilters)});`,
    `    return rows.map((row) => {`,
    ...embeddedHydrateLocals(agg, "row", "      ", ctx),
    `      return ${hydrateRootExpr(agg, "row", ctx)};`,
    `    });`,
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    ...mikroSaveTxLines(
      versioned ? versionedSaveLines : [`    const rootRow = ${rootRow};`, upsertCall],
    ),
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
    // Containment (de)serialisers — parts only; the root uses columns.
    ...agg.parts.flatMap((p) => [docTypeAlias(p, false, agg.name, ctx), ""]),
    ...agg.parts.flatMap((p) => [entityToDocFn(p, ctx), ""]),
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
      audited && `import { stampInsert${versioned ? ", stampUpdate" : ""} } from "../audit-stamp";`,
      `import { ${[agg.name, ...agg.parts.map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      `import { AggregateNotFoundError${versioned ? ", ConcurrencyError" : ""} } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}
