// -------------------------------------------------------------------------
// Relational-shape repository — the default persistence shape: join-table
// association load/save, value-collection rows, entity-part / nested-
// containment hydration + cascade delete, and the TPC/TPH inheritance base
// readers (inheritance storage only applies to the relational shape).
// Split out of mikroorm.ts by packet 2.6 (wave-2) — mechanical move, no
// logic change.
// -------------------------------------------------------------------------

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  ContainmentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  FieldIR,
  RepositoryIR,
  RetrievalIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { discriminatorValue, tableOwnerName } from "../../../ir/util/inheritance.js";
import { sortableFields } from "../../../ir/util/sortable-fields.js";
import { isValueCollectionType } from "../../../ir/util/value-collections.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../../util/naming.js";
import { joinColumnName } from "../emit.js";
import { synthProjectionFinds } from "../projection-finds.js";
import { isRefCollection } from "../repository-associations-builder.js";
import { deserializeField, serializeField } from "../repository-document-builder.js";
import { hydrateRootExpr } from "../repository-find-builder.js";
import { hydrateEntityExpr } from "../repository-find-hydrate.js";
import { repoPortImportLine, repoPortName } from "../repository-port-builder.js";
import {
  projectFieldEntries,
  projectionObject,
  provColumnEntries,
} from "../repository-save-builder.js";
import { aggHasFieldMask, toWireMaskedMethod, toWireMethod } from "../repository-wire-builder.js";
import { aggregateIsAudited, insertStampEntries, updateStampEntries } from "./audit-stamp.js";
import {
  MIKRO_OUTBOX_DRAIN_LINES,
  MIKRO_OUTBOX_RECORD_LINE,
  mikroSaveTxLines,
} from "./mikroorm-config.js";
import {
  isCollectionFieldType,
  joinRowClassOf,
  partRowClassOf,
  rowClassOf,
} from "./mikroorm-entities.js";
import {
  AMBIENT_PRINCIPAL,
  mikroContextFilters,
  mikroGetByIdLines,
  whereToMikroFilter,
  withContextFilters,
} from "./mikroorm-filter.js";
import { maskUserImport, tsParamType, usesRawFragment } from "./mikroorm-shared.js";

// ---------------------------------------------------------------------------
// `Id[]` reference-collection associations (many-to-many pivot tables).  The
// domain aggregate carries the collection as a bare `<field>` in `_rehydrate`
// (hydrateRootExpr emits `${f.name}`), so each read loads the target-id list
// from the pivot table into that local; the save does a full-list replace (set
// semantics — delete every owner row, insert the current list).  Mirrors the
// drizzle join-table path; no FK (MikroORM owns the schema via updateSchema),
// so the aggregate delete also clears the owner's pivot rows.
// ---------------------------------------------------------------------------

/** Bulk-load lines: each association → a `<field>ByOwner` map keyed by owner
 *  id, read from the pivot table for the `rootIds` in scope. */

function assocMapLoadLines(agg: EnrichedAggregateIR, emVar: string, indent: string): string[] {
  return (agg.associations ?? []).flatMap((a) => {
    const jc = joinRowClassOf(a);
    const oc = joinColumnName(a.ownerFk);
    const tc = joinColumnName(a.targetFk);
    const rows = `${a.fieldName}JoinRows`;
    const map = `${a.fieldName}ByOwner`;
    return [
      `${indent}const ${rows} = rootIds.length === 0 ? [] : await ${emVar}.find(${jc}, { ${oc}: { $in: rootIds } }, { orderBy: { ${oc}: "asc", ${tc}: "asc" } });`,
      `${indent}const ${map} = new Map<string, Ids.${a.targetAgg}Id[]>();`,
      `${indent}for (const jr of ${rows}) {`,
      `${indent}  const list = ${map}.get(jr.${oc}) ?? [];`,
      `${indent}  list.push(Ids.${a.targetAgg}Id(jr.${tc}));`,
      `${indent}  ${map}.set(jr.${oc}, list);`,
      `${indent}}`,
    ];
  });
}

/** Per-row `const <field> = <field>ByOwner.get(row.id) ?? [];` decls. */

function assocRowDeclLines(agg: EnrichedAggregateIR, rowVar: string, indent: string): string[] {
  return (agg.associations ?? []).map(
    (a) => `${indent}const ${a.fieldName} = ${a.fieldName}ByOwner.get(${rowVar}.id) ?? [];`,
  );
}

/** Inline single-owner association loads (findById) — `const <field> = (await
 *  em.find(pivot, { owner: id })).map(jr => Id(jr.target));`. */

function assocInlineLoadLines(
  agg: EnrichedAggregateIR,
  emVar: string,
  ownerIdExpr: string,
  indent: string,
): string[] {
  return (agg.associations ?? []).map((a) => {
    const jc = joinRowClassOf(a);
    const oc = joinColumnName(a.ownerFk);
    const tc = joinColumnName(a.targetFk);
    return `${indent}const ${a.fieldName} = (await ${emVar}.find(${jc}, { ${oc}: ${ownerIdExpr} }, { orderBy: { ${tc}: "asc" } })).map((jr) => Ids.${a.targetAgg}Id(jr.${tc}));`;
  });
}

/** Full-list-replace save of every association's pivot rows (set semantics). */

function assocSaveLines(agg: EnrichedAggregateIR, emVar: string, indent: string): string[] {
  return (agg.associations ?? []).flatMap((a) => {
    const jc = joinRowClassOf(a);
    const oc = joinColumnName(a.ownerFk);
    const tc = joinColumnName(a.targetFk);
    return [
      `${indent}// Full-list replace of the '${a.fieldName}' reference set.`,
      `${indent}await ${emVar}.nativeDelete(${jc}, { ${oc}: aggregate.id as string });`,
      `${indent}for (const t of aggregate.${a.fieldName}) {`,
      `${indent}  await ${emVar}.insert(${jc}, { ${oc}: aggregate.id as string, ${tc}: t as string });`,
      `${indent}}`,
    ];
  });
}

/** The array-hydration statement(s) binding `rows` → `${targetVar}`.  With
 *  associations it bulk-loads the pivot maps and assembles each row's list in a
 *  block; without, it stays the byte-identical single `.map(...)`. */
/** The value-object collection fields of an aggregate (`<VO>[]` root fields) —
 *  each stored INLINE as one jsonb column on the owner row. */

export function valueCollFieldsOf(agg: EnrichedAggregateIR): FieldIR[] {
  return agg.fields.filter((f) => isValueCollectionType(f.type));
}

/** Per-row value-collection decls binding `<field>` from the owner row's inline
 *  jsonb column (`const lineItems = (row.lineItems ?? []).map((x) => new Money(
 *  Number(x.amount), x.currency));`).  No DB round-trip — the array rides on the
 *  root row, so this is pure deserialisation.  The value-collection analogue of
 *  `assocRowDeclLines`; empty for an aggregate without VO collections, so the
 *  output stays byte-identical. */

function valueCollRowDeclLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  rowVar: string,
  indent: string,
): string[] {
  return valueCollFieldsOf(agg).map(
    (f) => `${indent}const ${f.name} = ${deserializeField(f.type, `${rowVar}.${f.name}`, ctx)};`,
  );
}

function assocHydrateBind(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  targetVar: string,
  keyword: "const" | "return",
  indent: string,
): string[] {
  const hy = hydrateRootExpr(agg, "row", ctx);
  const head = keyword === "return" ? "return" : `const ${targetVar} =`;
  const hasValueColls = valueCollFieldsOf(agg).length > 0;
  const hasChildren =
    (agg.associations ?? []).length > 0 || (agg.contains ?? []).length > 0 || hasValueColls;
  if (!hasChildren) {
    return [`${indent}${head} rows.map((row) => ${hy});`];
  }
  return [
    `${indent}const rootIds = rows.map((r) => r.id);`,
    ...assocMapLoadLines(agg, emVar, indent),
    ...containMapLoadLines(agg, ctx, emVar, indent),
    `${indent}${head} rows.map((row) => {`,
    ...assocRowDeclLines(agg, "row", `${indent}  `),
    ...containRowDeclLines(agg, "row", `${indent}  `),
    ...valueCollRowDeclLines(agg, ctx, "row", `${indent}  `),
    `${indent}  return ${hy};`,
    `${indent}});`,
  ];
}

// ---------------------------------------------------------------------------
// Contained entity parts (`contains <name>: <Part>[]` / singular).  Relational
// shape: each part is a parent-scoped `<Part>Row` child table.  Mirrors the
// `Id[]` association machinery — bulk-load into a `<name>ByParent` map on the
// array reads, inline-load on findById, diff-sync on save.  The domain root
// hydrates each containment from a bare `<name>` local (hydrateRootExpr), so
// these helpers just supply those locals.  NESTED parts (part-in-part) recurse
// (deepest-first loads / tree-position-stamped saves / cascade deletes), and a
// COLLECTION field on a part folds into one jsonb column — so the full
// containment tree round-trips (validator only gates event-sourced /
// aggregate-inheritance participants, which have no relational child-table home).
// ---------------------------------------------------------------------------

/** The entity part a containment names (undefined if malformed — validator-
 *  gated, so callers no-op). */

function partForContainment(agg: EnrichedAggregateIR, c: ContainmentIR): EntityPartIR | undefined {
  return (agg.parts ?? []).find((p) => p.name === c.partName);
}

/** The MikroORM part hydrate — `hydrateEntityExpr` with the collection-field
 *  override wired in: a part's array field is stored as one serialised jsonb
 *  column, so it (de)serialises through the shared `deserializeField` (VO/id/
 *  money elements reconstructed) rather than the drizzle native-array
 *  passthrough.  For a part with no collection field this is byte-identical to a
 *  bare `hydrateEntityExpr` (the override never fires). */

function mikroHydrateEntity(
  part: EntityPartIR,
  rowVar: string,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string {
  return hydrateEntityExpr(part, rowVar, agg, ctx, {
    collectionField: (f, rv) => deserializeField(f.type, `${rv}.${f.name}`, ctx),
  });
}

/** Save projection for a child part row — `{ id, parentId, <fields> }`,
 *  reusing the shared field projector so the columns match the Row entity.
 *
 *  A NESTED part (part-in-part) is stamped from TREE POSITION instead of the
 *  object's own `parentId`: a freshly-built nested part has no reliable
 *  construction-time parentId (a `new Label` inside a `new Shipment` has no
 *  shipment id yet), so the recursive save passes the enclosing loop variable's
 *  id as `parentIdExpr` — mirroring the drizzle `entityProjection` FK-stamp
 *  rule.  A COLLECTION field folds into one jsonb column, serialised through the
 *  shared `serializeField` (the MikroORM json column stores the plain value
 *  directly — VOs flattened to plain objects, ids/money to strings). */

function partProjection(
  part: EntityPartIR,
  varExpr: string,
  ctx: EnrichedBoundedContextIR,
  parentIdExpr?: string,
): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: parentIdExpr ?? `${varExpr}.parentId as string` },
    ...part.fields.flatMap((f) =>
      isCollectionFieldType(f.type)
        ? [{ fieldName: f.name, expr: serializeField(f.type, `${varExpr}.${f.name}`, ctx) }]
        : projectFieldEntries(f, varExpr, ctx),
    ),
  ]);
}

/** Recursively bulk-load a part's OWN nested containments (part-in-part) into
 *  per-direct-parent `<name>ByParent` maps keyed by the child row's id, emitted
 *  BEFORE the `hydrateEntityExpr` that references them.  `rowsVar` is the parent
 *  level's already-loaded rows array local.  Deepest-first: each level loads its
 *  rows (`parentId $in <parent ids>`), recurses to build grandchild maps, then
 *  groups its own rows (whose hydrate now finds the grandchild maps in scope).
 *  Empty for a leaf part, so single-level output is byte-identical.  The
 *  MikroORM analogue of the drizzle `nestedContainLoads`. */

function nestedContainMikroLoads(
  part: EntityPartIR,
  rowsVar: string,
  emVar: string,
  indent: string,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string[] {
  return part.contains.flatMap((nc) => {
    const ncPart = partForContainment(agg, nc);
    if (!ncPart) return [];
    const ncRow = partRowClassOf(ncPart.name);
    const rowsLocal = `${nc.name}Rows`;
    const out = [
      `${indent}const ${rowsLocal} = ${rowsVar}.length === 0 ? [] : await ${emVar}.find(${ncRow}, { parentId: { $in: ${rowsVar}.map((r) => r.id) } }, { orderBy: { parentId: "asc", id: "asc" } });`,
      ...nestedContainMikroLoads(ncPart, rowsLocal, emVar, indent, agg, ctx),
    ];
    if (nc.collection) {
      out.push(
        `${indent}const ${nc.name}ByParent = new Map<string, ${ncPart.name}[]>();`,
        `${indent}for (const r of ${rowsLocal}) {`,
        `${indent}  const list = ${nc.name}ByParent.get(r.parentId) ?? [];`,
        `${indent}  list.push(${mikroHydrateEntity(ncPart, "r", agg, ctx)});`,
        `${indent}  ${nc.name}ByParent.set(r.parentId, list);`,
        `${indent}}`,
      );
    } else {
      out.push(
        `${indent}const ${nc.name}ByParent = new Map<string, ${ncPart.name}>();`,
        `${indent}for (const r of ${rowsLocal}) {`,
        `${indent}  if (${nc.name}ByParent.has(r.parentId)) continue;`,
        `${indent}  ${nc.name}ByParent.set(r.parentId, ${mikroHydrateEntity(ncPart, "r", agg, ctx)});`,
        `${indent}}`,
      );
    }
    return out;
  });
}

/** Inline single-owner containment loads (findById / single find) — each
 *  containment bound to a `<name>` local from its child table. */

function containInlineLoadLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  ownerIdExpr: string,
  indent: string,
): string[] {
  return (agg.contains ?? []).flatMap((c) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    // A part with its OWN nested containments must materialise its child rows
    // into a local so `nestedContainMikroLoads` can build the `<nc>ByParent`
    // maps the hydrate references; a leaf part keeps the byte-identical inline
    // form.
    const hasNested = part.contains.length > 0;
    if (c.collection) {
      if (!hasNested)
        return [
          `${indent}const ${c.name} = (await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } })).map((r) => ${mikroHydrateEntity(part, "r", agg, ctx)});`,
        ];
      const rows = `${c.name}Rows`;
      return [
        `${indent}const ${rows} = await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } });`,
        ...nestedContainMikroLoads(part, rows, emVar, indent, agg, ctx),
        `${indent}const ${c.name} = ${rows}.map((r) => ${mikroHydrateEntity(part, "r", agg, ctx)});`,
      ];
    }
    if (!hasNested)
      return [
        `${indent}const ${c.name}Row = await ${emVar}.findOne(${prow}, { parentId: ${ownerIdExpr} });`,
        `${indent}const ${c.name} = ${c.name}Row === null ? null : ${mikroHydrateEntity(part, `${c.name}Row`, agg, ctx)};`,
      ];
    const rows = `${c.name}Rows`;
    return [
      `${indent}const ${rows} = await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } });`,
      ...nestedContainMikroLoads(part, rows, emVar, indent, agg, ctx),
      `${indent}const ${c.name} = ${rows}.length === 0 ? null : ${mikroHydrateEntity(part, `${rows}[0]!`, agg, ctx)};`,
    ];
  });
}

/** Bulk-load every containment into a `<name>ByParent` map keyed by owner id
 *  (the array-read analogue of `assocMapLoadLines`). */

function containMapLoadLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  indent: string,
): string[] {
  return (agg.contains ?? []).flatMap((c) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    const rows = `${c.name}Rows`;
    const map = `${c.name}ByParent`;
    const elemT = c.collection ? `${part.name}[]` : part.name;
    // Load this containment's rows, then (for a part with its OWN nested
    // containments) recursively build the child `<nc>ByParent` maps BEFORE the
    // grouping hydrate references them.  Empty for a leaf part → byte-identical
    // single-level output.
    const rowsDecl = `${indent}const ${rows} = rootIds.length === 0 ? [] : await ${emVar}.find(${prow}, { parentId: { $in: rootIds } }, { orderBy: { parentId: "asc", id: "asc" } });`;
    const nested = nestedContainMikroLoads(part, rows, emVar, indent, agg, ctx);
    const mapDecl = `${indent}const ${map} = new Map<string, ${elemT}>();`;
    if (c.collection) {
      return [
        rowsDecl,
        ...nested,
        mapDecl,
        `${indent}for (const r of ${rows}) {`,
        `${indent}  const list = ${map}.get(r.parentId) ?? [];`,
        `${indent}  list.push(${mikroHydrateEntity(part, "r", agg, ctx)});`,
        `${indent}  ${map}.set(r.parentId, list);`,
        `${indent}}`,
      ];
    }
    return [
      rowsDecl,
      ...nested,
      mapDecl,
      `${indent}for (const r of ${rows}) ${map}.set(r.parentId, ${mikroHydrateEntity(part, "r", agg, ctx)});`,
    ];
  });
}

/** Per-row containment decls binding `<name>` from the bulk `<name>ByParent`
 *  map (the array-read analogue of `assocRowDeclLines`). */

function containRowDeclLines(agg: EnrichedAggregateIR, rowVar: string, indent: string): string[] {
  return (agg.contains ?? []).map(
    (c) =>
      `${indent}const ${c.name} = ${c.name}ByParent.get(${rowVar}.id) ?? ${c.collection ? "[]" : "null"};`,
  );
}

/** Diff-sync each containment's child rows on save: delete the rows the owner no
 *  longer holds, upsert the current set (id is the PK), then RECURSE into each
 *  part's own nested containments keyed by that part instance's id.  The
 *  MikroORM analogue of the drizzle `syncContain`: `depth` uniquifies the loop /
 *  `existing` / `currentIds` locals across levels, and a NESTED part's `parentId`
 *  is stamped from tree position (the enclosing loop variable's id) rather than
 *  the object's own — a freshly-built nested part has no reliable parentId. */

function containSaveLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  indent: string,
): string[] {
  const sync = (
    containments: readonly ContainmentIR[],
    ownerExpr: string,
    ownerIdExpr: string,
    ind: string,
    depth: number,
  ): string[] =>
    containments.flatMap((c) => {
      const part = partForContainment(agg, c);
      if (!part) return [];
      const prow = partRowClassOf(part.name);
      const suffix = depth === 0 ? "" : String(depth);
      const cap = `${upperFirst(c.name)}${suffix}`;
      const loopVar = `child${suffix}`;
      const itemsRef = c.collection
        ? `${ownerExpr}.${c.name}`
        : `(${ownerExpr}.${c.name} ? [${ownerExpr}.${c.name}] : [])`;
      // Root-level part keeps its own `parentId`; a nested part FKs to the
      // enclosing loop variable's id (tree position).
      const parentIdExpr = depth === 0 ? undefined : `${ownerExpr}.id as string`;
      return [
        `${ind}// Full child sync of the '${c.name}' containment.`,
        `${ind}const existing${cap} = await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} });`,
        `${ind}const currentIds${cap} = new Set(${itemsRef}.map((e) => e.id as string));`,
        `${ind}for (const r of existing${cap}) {`,
        `${ind}  if (!currentIds${cap}.has(r.id)) await ${emVar}.nativeDelete(${prow}, { id: r.id });`,
        `${ind}}`,
        `${ind}for (const ${loopVar} of ${itemsRef}) {`,
        `${ind}  await ${emVar}.upsert(${prow}, ${partProjection(part, loopVar, ctx, parentIdExpr)});`,
        ...sync(part.contains, loopVar, `${loopVar}.id as string`, `${ind}  `, depth + 1),
        `${ind}}`,
      ];
    });
  return sync(agg.contains ?? [], "aggregate", "aggregate.id as string", indent, 0);
}

/** Recursive cascade-delete of a subtree of contained child rows.  MikroORM
 *  owns the schema and the generated EntitySchemas carry no relation/FK, so
 *  there's no DB cascade — the repository clears descendants explicitly,
 *  DEEPEST-first.  A leaf part deletes straight by `parentId`; a part with its
 *  own nested containments first loads its row ids, recurses to clear
 *  grandchildren (`parentId $in <ids>`), then deletes its own rows.  For a
 *  single-level aggregate this reduces to the original one-liner per part
 *  (byte-identical).  `parentIdValue` is the `parentId` FilterQuery VALUE (an
 *  `id as string` at the root, a `{ $in: <ids> }` object below). */

function containCascadeDeleteLines(
  agg: EnrichedAggregateIR,
  emVar: string,
  parentIdValue: string,
  indent: string,
  depth: number,
): string[] {
  return containCascade(agg, agg.contains ?? [], emVar, parentIdValue, indent, depth);
}

function containCascade(
  agg: EnrichedAggregateIR,
  containments: readonly ContainmentIR[],
  emVar: string,
  parentIdValue: string,
  indent: string,
  depth: number,
): string[] {
  return containments.flatMap((c, i) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    if (part.contains.length === 0) {
      return [`${indent}await ${emVar}.nativeDelete(${prow}, { parentId: ${parentIdValue} });`];
    }
    const idsVar = `${c.name}DelIds${depth === 0 ? "" : depth}${i === 0 ? "" : `_${i}`}`;
    return [
      `${indent}const ${idsVar} = (await ${emVar}.find(${prow}, { parentId: ${parentIdValue} })).map((r) => r.id);`,
      ...containCascade(agg, part.contains, emVar, `{ $in: ${idsVar} }`, indent, depth + 1),
      `${indent}await ${emVar}.nativeDelete(${prow}, { parentId: ${parentIdValue} });`,
    ];
  });
}

// ---------------------------------------------------------------------------
// Per-aggregate repository — a drop-in for the drizzle `<Agg>Repository`.
// ---------------------------------------------------------------------------

export function renderMikroRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  // TPH (aggregate-inheritance.md, sharedTable): a concrete subtype has no Row
  // of its own — it reads/writes the base's shared table, scoped to its `kind`
  // discriminator on every read and stamping `kind` on every write.  The Row
  // class + table are the base's; `kindClause` is ANDed into each read filter.
  const pool = ctx.aggregates;
  const kind = discriminatorValue(agg, pool);
  const rowAgg = tableOwnerName(agg, pool);
  const row = rowClassOf(rowAgg);
  const kindClause = kind ? [`{ kind: ${JSON.stringify(kind)} }`] : [];
  const kindProjection = kind ? [{ fieldName: "kind", expr: JSON.stringify(kind) }] : [];
  const hydrate = (rowVar: string) => hydrateRootExpr(agg, rowVar, ctx);
  // Capability `filter` predicates AND into every root read.  `baseFilters` is
  // the no-`ignoring` set (findById / findManyByIds / retrievals); each find
  // recomputes with its own `ignoring` bypass.  Empty when the aggregate has no
  // `filter` capability, so the read FilterQuery stays byte-identical.  The TPH
  // `kind` scope rides the same `$and` composition as a capability filter.
  const baseFilters = [...mikroContextFilters(agg), ...kindClause];
  // `Id[]` reference collections persist in pivot tables, not columns, so they
  // are excluded from the aggregate-row save projection (synced separately).
  // Value-object collections (`<VO>[]`) fold onto one inline jsonb column each,
  // serialised through the shared `serializeField` (VO elements → plain objects,
  // money/id → strings) — the root analogue of the part-collection jsonb column.
  const scalarFields = agg.fields.filter(
    (f) => !isRefCollection(f.type) && !isValueCollectionType(f.type),
  );
  const valueCollFields = valueCollFieldsOf(agg);
  const valueCollEntries = valueCollFields.map((f) => ({
    fieldName: f.name,
    expr: serializeField(f.type, `aggregate.${f.name}`, ctx),
  }));
  const hasAssocs = (agg.associations ?? []).length > 0;
  const hasContains = (agg.contains ?? []).length > 0;
  const hasValueColls = valueCollFields.length > 0;
  const hasChildren = hasAssocs || hasContains;
  // Whether a read must declare per-row hydrate locals before the `_rehydrate`
  // (associations / contained parts / value-object collections all bind a bare
  // `<field>` local `hydrateRootExpr` references).  A plain flat aggregate has
  // none, so its single-row reads stay the byte-identical inline expression.
  const hasHydrateLocals = hasChildren || hasValueColls;
  // The id (primary key) leads the upsert payload — `projectFieldEntries`
  // covers only the declared fields, so it's prepended explicitly (matching
  // the drizzle save row).
  // Co-located provenance sidecar (provenance.md): each provenanced field's
  // `<field>_provenance` jsonb column reads straight off the domain getter, the
  // same shared entries the drizzle root projection uses.  Empty for a plain
  // aggregate → byte-identical mikro output.
  const provEntries = provColumnEntries(agg.fields, "aggregate");
  const saveProjection = projectionObject("aggregate", [
    { fieldName: "id", expr: "aggregate.id as string" },
    ...kindProjection,
    ...scalarFields.flatMap((f) => projectFieldEntries(f, "aggregate", ctx)),
    ...valueCollEntries,
    ...provEntries,
  ]);

  // Persist-time audit stamping (node-persist-time-auditing): on an audited
  // aggregate the upsert payload is wrapped in `stampInsert(...)` so the audit
  // columns are filled from the ambient request principal at save time, and
  // the create-only columns (createdAt/createdBy — insert-set minus update-set)
  // are excluded from the conflict UPDATE via `onConflictExcludeFields`, so a
  // re-save leaves them at their on-disk values (immutable).  A non-audited
  // aggregate keeps the byte-identical bare upsert.
  const audited = aggregateIsAudited(agg);
  const upsertCall = audited
    ? (() => {
        const updateFields = new Set(updateStampEntries(agg).map((e) => e.field));
        const createOnly = insertStampEntries(agg)
          .map((e) => e.field)
          .filter((f) => !updateFields.has(f));
        const opts =
          createOnly.length > 0
            ? `, { onConflictExcludeFields: [${createOnly.map((f) => JSON.stringify(f)).join(", ")}] }`
            : "";
        return `    await em.upsert(${row}, stampInsert(${saveProjection})${opts});`;
      })()
    : `    await em.upsert(${row}, ${saveProjection});`;

  // Versioned optimistic-concurrency save (M-T3.4, default-on) — the MikroORM
  // analogue of the drizzle guarded write (repository-save-builder.ts).  No
  // existing row → `em.insert` seeding `version: 1`.  Existing row → a guarded
  // `em.nativeUpdate` whose WHERE pins `version = expected` and whose SET bumps
  // it; zero affected rows means another request won the race in between →
  // `ConcurrencyError` (mapped to 409 by the shared onError arm).  `expected` is
  // the caller's `expectedVersion` (threaded from the route's `If-Match`) falling
  // back to the just-loaded `aggregate.version`.
  const versioned = aggregateIsVersioned(agg);
  const nonVersionEntries = scalarFields
    .filter((f) => f.name !== "version")
    .flatMap((f) => projectFieldEntries(f, "aggregate", ctx));
  const insertProjection = projectionObject("aggregate", [
    { fieldName: "id", expr: "aggregate.id as string" },
    ...kindProjection,
    ...nonVersionEntries,
    ...valueCollEntries,
    ...provEntries,
    { fieldName: "version", expr: "1" },
  ]);
  const updateData = projectionObject("aggregate", [
    ...kindProjection,
    ...nonVersionEntries,
    ...valueCollEntries,
    ...provEntries,
    { fieldName: "version", expr: "expected + 1" },
  ]);
  const insertValues = audited ? `stampInsert(${insertProjection})` : insertProjection;
  const updateSet = audited ? `stampUpdate(${updateData})` : updateData;
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
      // The find's own `where`, AND-ed with the aggregate's capability filters
      // (dropping the ones this read's `ignoring` clause bypasses).
      const caps = [
        ...mikroContextFilters(agg, { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps }),
        ...kindClause,
      ];
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
    // Paged return (`find x(): <Agg> paged`; the auto-`findAll` after M-T2.6):
    // trailing `page`/`pageSize`/`sort`/`dir` controls → a `em.count` +
    // `em.find` with `limit`/`offset`/`orderBy`, wrapped in the paged envelope.
    // Server-side sort is whitelisted to scalar root columns (`sortableFields`);
    // an unknown key falls back to `id` (the stable default order — the route's
    // zod enum already rejects out-of-whitelist keys).  MikroORM aggregates are
    // flat, so no child bulk-load — the page rows hydrate the same way the
    // array branch does.
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
        ...assocHydrateBind(agg, ctx, "em", "items", "const", "    "),
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
        ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
        `  }`,
      );
    }
    // Single-row find: load the children inline (owner id known) then
    // hydrate, mirroring findById.  Value-object collections need a per-row
    // local too (deserialised off the row's inline jsonb column), so the block
    // form fires for them as well as for associations / contained parts.
    if (hasHydrateLocals) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name} | null> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const row = await em.findOne(${row}, ${filter});`,
        `    if (row === null) return null;`,
        ...assocInlineLoadLines(agg, "em", "row.id", "    "),
        ...containInlineLoadLines(agg, ctx, "em", "row.id", "    "),
        ...valueCollRowDeclLines(agg, ctx, "row", "    "),
        `    return ${hydrate("row")};`,
        `  }`,
      );
    }
    return lines(
      `  async ${name}(${params}): Promise<${agg.name} | null> {`,
      `    const em = this.em.fork({ keepTransactionContext: true });`,
      `    const row = await em.findOne(${row}, ${filter});`,
      `    return row === null ? null : ${hydrate("row")};`,
      `  }`,
    );
  });

  // Context `retrieval` query bundles targeting this aggregate (retrieval.md) —
  // emitted as `run<Name>(...)` methods, the MikroORM analogue of the drizzle
  // `runMethod` (DEBT-17).  The `where` lowers through the same `whereToMikroFilter`
  // oracle a find uses (so the same subset is supported; an out-of-subset
  // predicate emits a runtime-throwing stub).  `sort` → `em.find` `orderBy`, and
  // a call-site `page` → `limit`/`offset` (never part of the declaration —
  // mirrors the drizzle path).  The validator gates parts/non-relational off
  // this adapter, so the hydrate is the flat `hydrateRootExpr` the finds use;
  // `Id[]` reference collections (associations) bulk-load from their pivot
  // tables via `assocHydrateBind`, same as an array find.
  const retrievalMethods = (ctx.retrievals ?? [])
    .filter(
      (r): r is RetrievalIR => r.targetType.kind === "entity" && r.targetType.name === agg.name,
    )
    .map((r) => {
      const methodName = `run${upperFirst(r.name)}`;
      const baseParams = r.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
      const params = [...baseParams, "page?: { offset?: number; limit?: number }"].join(", ");
      let filter: string;
      try {
        // Retrievals read the aggregate table, so the capability filters AND in
        // too (no `ignoring` surface on retrievals — the no-bypass `baseFilters`).
        filter = withContextFilters(whereToMikroFilter(r.where), baseFilters);
      } catch {
        return lines(
          `  async ${methodName}(${params}): Promise<${agg.name}[]> {`,
          `    throw new Error("mikroorm v1: this retrieval's predicate is not yet supported");`,
          `  }`,
        );
      }
      // `sort` → MikroORM `orderBy`.  Only the first path segment (a direct
      // column) is used in v1 — nested / collection sort paths are gated by
      // validateRetrievals, same as the drizzle path.
      const orderBy =
        r.sort.length > 0
          ? `, orderBy: { ${r.sort.map((s) => `${s.path[0]!.name}: "${s.direction}"`).join(", ")} }`
          : "";
      return lines(
        `  async ${methodName}(${params}): Promise<${agg.name}[]> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const rows = await em.find(${row}, ${filter}, { limit: page?.limit, offset: page?.offset${orderBy} });`,
        dbg(r.name, "rows.length"),
        ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
        `  }`,
      );
    });

  const deleteMethod = agg.canonicalDestroy
    ? hasChildren
      ? lines(
          `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
          `    const em = this.em.fork({ keepTransactionContext: true });`,
          // No FK cascade (MikroORM owns the schema), so clear the owner's
          // pivot rows + contained child rows before the root delete.
          ...(agg.associations ?? []).map(
            (a) =>
              `    await em.nativeDelete(${joinRowClassOf(a)}, { ${joinColumnName(a.ownerFk)}: id as string });`,
          ),
          ...containCascadeDeleteLines(agg, "em", "id as string", "    ", 0),
          `    await em.nativeDelete(${row}, ${withContextFilters("{ id: id as string }", kindClause)});`,
          `  }`,
        )
      : lines(
          `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
          `    await this.em.fork({ keepTransactionContext: true }).nativeDelete(${row}, ${withContextFilters("{ id: id as string }", kindClause)});`,
          `  }`,
        )
    : "";

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    // Explicit field declarations + constructor assignments, not
    // parameter properties — see emit/value-objects.ts's renderValueObject.
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
    `  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const row = await em.findOne(${row}, ${withContextFilters("{ id: id as string }", baseFilters)});`,
    `    if (row === null) {`,
    `      requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: false });`,
    `      return null;`,
    `    }`,
    ...assocInlineLoadLines(agg, "em", "id as string", "    "),
    ...containInlineLoadLines(agg, ctx, "em", "id as string", "    "),
    ...valueCollRowDeclLines(agg, ctx, "row", "    "),
    `    const loaded = ${hydrate("row")};`,
    `    requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: true });`,
    `    return loaded;`,
    `  }`,
    "",
    ...mikroGetByIdLines(agg, `Ids.${agg.name}Id`, row),
    "",
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, ${withContextFilters("{ id: { $in: ids as string[] } }", baseFilters)});`,
    ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    ...MIKRO_OUTBOX_DRAIN_LINES,
    ...mikroSaveTxLines([
      ...(versioned ? versionedSaveLines : [upsertCall]),
      ...(hasAssocs ? assocSaveLines(agg, "em", "    ") : []),
      ...(hasContains ? containSaveLines(agg, ctx, "em", "    ") : []),
      MIKRO_OUTBOX_RECORD_LINE,
    ]),
    `    requestLog().debug({ event: "repository_save", aggregate: "${agg.name}", id: aggregate.id as string });`,
    "",
    `    for (const event of dispatchAfterCommit) {`,
    `      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string });`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    deleteMethod ? "" : null,
    deleteMethod || null,
    ...findMethods.flatMap((m) => ["", m]),
    ...retrievalMethods.flatMap((m) => ["", m]),
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
  );

  // Narrow VO/enum imports to the symbols the body actually references
  // (value when `new <Vo>(` or `<Enum>.<member>`, else type-only) — same
  // body-scan strategy the drizzle repository builder uses.
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
      maskUserImport(agg, repo),
      // The aggregate Row + every `Id[]` association's pivot Row entity + each
      // contained entity part's child Row entity.
      `import { ${[
        row,
        ...(agg.associations ?? []).map(joinRowClassOf),
        ...(agg.parts ?? []).map((p) => partRowClassOf(p.name)),
      ].join(", ")} } from "../entities";`,
      // Persist-time audit stamping helper — pulled in only when this
      // aggregate's `save()` stamps (audited).  Stamps the audit columns from
      // the ambient request principal at the upsert (db/audit-stamp.ts).
      audited && `import { stampInsert${versioned ? ", stampUpdate" : ""} } from "../audit-stamp";`,
      // The aggregate root + its contained entity parts (same domain module).
      `import { ${[agg.name, ...(agg.parts ?? []).map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
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

// ---------------------------------------------------------------------------
// Polymorphic base readers (aggregate-inheritance.md) — MikroORM editions of
// the drizzle `buildBaseReaderFile` / `buildTpcBaseReaderFile`.  An abstract
// base owns no user repository (validator-forbidden), but polymorphic access
// ("reference any PaymentMethod, query all of them") still needs a read home:
// a `<Base>Repository` returning the `Concrete | …` tagged union.
// ---------------------------------------------------------------------------

/** TPH (`sharedTable`) read-only `<Base>Repository`.
 *
 *  DELEGATES to the per-concrete repositories, exactly like the TPC reader
 *  below.  It used to scan the shared Row itself (`em.find(<Base>Row, {})`) and
 *  hydrate by `kind`, which meant it saw that Row through NONE of the machinery
 *  the concrete repositories apply to it — no capability `filter`, no tenancy
 *  predicate, no contained parts.  That is a cross-tenant read the moment the
 *  polymorphic reader is wired to a route (`F2-CB-C12`, the drizzle twin of
 *  which `buildBaseReaderFile` fixes the same way). */

export function renderMikroBaseReader(
  base: EnrichedAggregateIR,
  concretes: readonly EnrichedAggregateIR[],
): string {
  return renderMikroDelegatingBaseReader(base, concretes, "sharedTable");
}

/** TPC (`ownTable`) read-only `<Base>Repository` — each concrete is its own
 *  table with a full repository, so this DELEGATES: `findAll` unions each
 *  concrete's `all()`, `findById` tries each in turn.  Every aggregate loads
 *  its complete tree through the loader that already knows how (mirrors the
 *  drizzle `buildTpcBaseReaderFile`; N round-trips traded for reuse). */

export function renderMikroTpcBaseReader(
  base: EnrichedAggregateIR,
  concretes: readonly EnrichedAggregateIR[],
): string {
  return renderMikroDelegatingBaseReader(base, concretes, "ownTable");
}

/** The polymorphic base reader for either layout: `findAll` unions each
 *  concrete's `all()`, `findById` tries each in turn.  N round-trips traded for
 *  reuse — and for filter correctness, since each concrete's own read path
 *  carries its capability predicates. */

function renderMikroDelegatingBaseReader(
  base: EnrichedAggregateIR,
  concretes: readonly EnrichedAggregateIR[],
  layout: "sharedTable" | "ownTable",
): string {
  const repoCtor = (c: EnrichedAggregateIR): string => `${c.name}Repository`;
  const repoField = (c: EnrichedAggregateIR): string => `${lowerFirst(c.name)}Repo`;
  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      `import * as Ids from "../../domain/ids";`,
      ...concretes.map(
        (c) => `import { ${repoCtor(c)} } from "./${lowerFirst(c.name)}-repository";`,
      ),
      `import type { ${base.name} } from "../../domain/${lowerFirst(base.name)}";`,
      "",
      `// Polymorphic ${base.name} reader (${layout === "ownTable" ? "TPC / ownTable" : "TPH / sharedTable"}): delegates to`,
      `// each concrete repository so every aggregate loads its full tree — and`,
      `// through its own capability filters — then unions the results.`,
      `// Read-only; writes go through the per-concrete repos.`,
      `export class ${base.name}Repository {`,
      ...concretes.map((c) => `  private readonly ${repoField(c)}: ${repoCtor(c)};`),
      `  constructor(em: EntityManager, events: DomainEventDispatcher) {`,
      ...concretes.map((c) => `    this.${repoField(c)} = new ${repoCtor(c)}(em, events);`),
      `  }`,
      "",
      `  async findById(id: Ids.${base.name}Id): Promise<${base.name} | null> {`,
      ...concretes.flatMap((c) => [
        `    const ${repoField(c)}Hit = await this.${repoField(c)}.findById(id as unknown as Ids.${c.name}Id);`,
        `    if (${repoField(c)}Hit) return ${repoField(c)}Hit;`,
      ]),
      `    return null;`,
      `  }`,
      "",
      `  async findAll(): Promise<${base.name}[]> {`,
      `    const results = await Promise.all([`,
      ...concretes.map((c) => `      this.${repoField(c)}.all(),`),
      `    ]);`,
      `    return results.flat();`,
      `  }`,
      `}`,
      "",
    ) + "\n"
  );
}
