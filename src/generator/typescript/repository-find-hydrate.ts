// Repository hydrate family — row → domain `_rehydrate(...)` expression
// builders for the Hono/Drizzle read paths.  Extracted from
// repository-find-builder.ts: these turn a Drizzle row (root, contained
// entity part, or shared TPH row) into the domain constructor call the
// find methods splice into their emitted bodies.  Pure leaf — the find
// method builders depend on these, never the other way around.

import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  EntityPartIR,
  FieldIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { isTphConcrete } from "../../ir/util/inheritance.js";
import { isValueCollectionType, type ValueCollectionIR } from "../../ir/util/value-collections.js";
import { valueObjectColumnNames } from "./emit.js";
import { isRefCollection } from "./repository-associations-builder.js";

export function hydrateRootExpr(
  agg: EnrichedAggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  // A TPH concrete reads from the shared table, where its own (non-base)
  // columns are nullable (only this `kind`'s rows populate them). The `kind`
  // filter on every read guarantees they're present, so assert non-null on
  // hydrate — otherwise `string | null` columns fail the domain `_create`
  // signature under strict tsc.
  const forceNonNull = isTphConcrete(agg, ctx.aggregates);
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    if (isRefCollection(f.type) || isValueCollectionType(f.type)) {
      // Loaded into a local const from its join / child table (see
      // findByIdMethod): a reference collection from the join table, a
      // value-object collection from its id-less child table.
      fields.push(`${f.name}`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx, forceNonNull)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    fields.push(`${c.name}`);
  }
  return `${agg.name}._rehydrate({ ${fields.join(", ")} })`;
}

/** Construct one value object from a child-collection row.  Each VO field
 *  reads its own column off the row via `hydrateValueExpr` (decimal→Number,
 *  nested VO → its flattened columns), matching the child table the schema
 *  emitter laid down.  Exported so the find-method builder can splice it
 *  into the per-collection load loops. */
export function valueCollectionElementExpr(
  vc: ValueCollectionIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  const vo = ctx.valueObjects.find((v) => v.name === vc.voName);
  const args = (vo?.fields ?? [])
    .map((vf) => hydrateValueExpr(vf.name, vf.type, rowVar, ctx, vf.optional))
    .join(", ");
  return `new ${vc.voName}(${args})`;
}

/** Hydrate a TPH concrete directly from a shared-table row — used by the
 *  polymorphic base reader (`PartyRepository`), which scans the shared table
 *  and dispatches on `kind`.  Reads scalar / value-object / enum / id columns
 *  with the non-null assertion (the row is known to be this concrete's
 *  `kind`).  Contained parts and `X id[]` reference collections aren't eagerly
 *  loaded by the base read (the per-concrete repository loads those fully) —
 *  they default to empty/null here so the `_create` stays strictly typed;
 *  v1 TPH concretes are expected to be flat (aggregate-inheritance.md). */
export function hydrateConcreteFromSharedRow(
  agg: EnrichedAggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [`id: Ids.${agg.name}Id(${rowVar}.id)`];
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      fields.push(`${f.name}: []`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx, true)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    fields.push(`${c.name}: ${c.collection ? "[]" : "null"}`);
  }
  return `${agg.name}._rehydrate({ ${fields.join(", ")} })`;
}

function provHydrateEntries(fields: FieldIR[], rowVar: string): string[] {
  return fields
    .filter((f) => f.provenanced)
    .map((f) => `${f.name}_provenance: ${rowVar}.${f.name}_provenance ?? null`);
}

export function hydrateEntityExpr(
  part: EntityPartIR,
  rowVar: string,
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${part.name}Id(${rowVar}.id)`);
  fields.push(`parentId: Ids.${agg.name}Id(${rowVar}.parentId)`);
  for (const f of part.fields) {
    fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
  }
  fields.push(...provHydrateEntries(part.fields, rowVar));
  return `${part.name}._rehydrate({ ${fields.join(", ")} })`;
}

function hydrateFieldExpr(
  f: FieldIR,
  rowVar: string,
  ctx: BoundedContextIR,
  forceNonNull = false,
): string {
  return hydrateValueExpr(f.name, f.type, rowVar, ctx, f.optional, forceNonNull);
}

function hydrateValueExpr(
  fieldName: string,
  t: TypeIR,
  rowVar: string,
  ctx: BoundedContextIR,
  optional: boolean,
  forceNonNull = false,
): string {
  // For a TPH concrete's required column (nullable in the shared table, but
  // guaranteed present by the `kind` filter), assert non-null on read.
  // Optional fields keep their own `== null` guard, so no bang there.
  const bang = forceNonNull && !optional ? "!" : "";
  const colExpr = `${rowVar}.${fieldName}${bang}`;
  if (t.kind === "optional") {
    return `(${rowVar}.${fieldName} == null ? null : ${hydrateValueExpr(fieldName, t.inner, rowVar, ctx, true, forceNonNull)})`;
  }
  if (t.kind === "primitive") {
    // decimal hydrates lossy through JS `number` — money does NOT
    // (it would defeat the precision contract that justifies money's
    // existence).  Drizzle's `numeric()` column returns a string at
    // runtime, which `new Decimal(...)` consumes without precision
    // loss.
    if (t.name === "decimal") return `Number(${colExpr})`;
    if (t.name === "money") return `new Decimal(${colExpr})`;
    return colExpr;
  }
  if (t.kind === "id") {
    return `Ids.${t.targetName}Id(${colExpr})`;
  }
  if (t.kind === "enum") {
    return `${colExpr} as ${t.name}`;
  }
  if (t.kind === "valueobject") {
    const cols = valueObjectColumnNames(fieldName, t.name, ctx);
    const args = cols
      .map((c) => primitiveColumnRead(`${rowVar}.${c.columnName}${bang}`, c.type))
      .join(", ");
    if (optional) {
      return `(${rowVar}.${cols[0]!.columnName} == null ? null : new ${t.name}(${args}))`;
    }
    return `new ${t.name}(${args})`;
  }
  return colExpr;
}

function primitiveColumnRead(expr: string, t: TypeIR): string {
  if (t.kind === "primitive" && t.name === "decimal") return `Number(${expr})`;
  if (t.kind === "primitive" && t.name === "money") return `new Decimal(${expr})`;
  return expr;
}

/** Variant of `hydrateRootExpr` where ALL containments
 * (collections + singulars) are pre-loaded into per-parent maps.
 * Used by the array-returning find path to fully hydrate every root
 * in one batched read.  Singular containments default to `null` if
 * the parent had no row in the bulk join. */
export function hydrateRootForFindAllExpr(
  agg: EnrichedAggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  // See hydrateRootExpr: TPH concrete own columns are nullable in the shared
  // table but present for this `kind`, so assert non-null on read.
  const forceNonNull = isTphConcrete(agg, ctx.aggregates);
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      fields.push(`${f.name}: ${f.name}ByOwner.get(${rowVar}.id) ?? []`);
    } else if (isValueCollectionType(f.type)) {
      fields.push(`${f.name}: ${f.name}ByParent.get(${rowVar}.id) ?? []`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx, forceNonNull)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    if (c.collection) {
      fields.push(`${c.name}: ${c.name}ByParent.get(${rowVar}.id) ?? []`);
    } else {
      fields.push(`${c.name}: ${c.name}ByParent.get(${rowVar}.id) ?? null`);
    }
  }
  return `${agg.name}._rehydrate({ ${fields.join(", ")} })`;
}
