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
import { directParentName } from "../../ir/util/containment-parent.js";
import { isTphConcrete } from "../../ir/util/inheritance.js";
import { isValueCollectionType, type ValueCollectionIR } from "../../ir/util/value-collections.js";
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
  /** Opt-in override for a COLLECTION (array-typed) part field.  Drizzle stores
   *  scalar/enum arrays as native array columns (the default passthrough reads
   *  `row.<field>` directly), so it passes nothing.  A backend that instead
   *  stores a part's collection field as a serialised jsonb column (MikroORM)
   *  supplies this to (de)serialise the element type on read — kept off the
   *  shared path so drizzle output stays byte-identical. */
  opts?: { collectionField?: (f: FieldIR, rowVar: string) => string },
): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${part.name}Id(${rowVar}.id)`);
  // A nested part's parentId is branded to its DIRECT parent (a sibling part),
  // not the aggregate root — matching the schema FK it was loaded through.
  fields.push(`parentId: Ids.${directParentName(agg, part.name, agg.name)}Id(${rowVar}.parentId)`);
  for (const f of part.fields) {
    const arr = f.type.kind === "optional" ? f.type.inner : f.type;
    if (opts?.collectionField && arr.kind === "array") {
      fields.push(`${f.name}: ${opts.collectionField(f, rowVar)}`);
      continue;
    }
    fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
  }
  fields.push(...provHydrateEntries(part.fields, rowVar));
  // Nested containments: reference the per-direct-parent maps the caller loaded
  // just before this hydrate (`<name>ByParent`, keyed by this part row's id).
  for (const nc of part.contains) {
    fields.push(
      `${nc.name}: ${nc.name}ByParent.get(${rowVar}.id) ?? ${nc.collection ? "[]" : "null"}`,
    );
  }
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
  voSubfield = false,
): string {
  // For a TPH concrete's required column (nullable in the shared table, but
  // guaranteed present by the `kind` filter), assert non-null on read.
  // Optional fields keep their own `== null` guard, so no bang there.
  const bang = forceNonNull && !optional ? "!" : "";
  const colExpr = `${rowVar}.${fieldName}${bang}`;
  if (t.kind === "optional") {
    return `(${rowVar}.${fieldName} == null ? null : ${hydrateValueExpr(fieldName, t.inner, rowVar, ctx, true, forceNonNull, voSubfield)})`;
  }
  if (t.kind === "primitive") {
    // decimal hydrates lossy through JS `number` — money does NOT
    // (it would defeat the precision contract that justifies money's
    // existence).  Drizzle's `numeric()` column returns a string at
    // runtime, which `new Decimal(...)` consumes without precision
    // loss.
    if (t.name === "decimal") return `Number(${colExpr})`;
    if (t.name === "money") return `new Decimal(${colExpr})`;
    // File hydrates from a JSONB column (drizzle types it `unknown`) — cast to
    // the fixed FileRef shape the domain field declares.
    if (t.name === "File")
      return `(${colExpr} as { url: string; key: string; contentType: string; size: number })`;
    return colExpr;
  }
  if (t.kind === "id") {
    return `Ids.${t.targetName}Id(${colExpr})`;
  }
  if (t.kind === "enum") {
    // A VO subfield's pgEnum column already carries the literal-union type,
    // and repositories don't import enum names for VO subfields — casting
    // would reference an unimported type name (tsc TS2304).
    return voSubfield ? colExpr : `${colExpr} as ${t.name}`;
  }
  if (t.kind === "valueobject") {
    // Recurse per subfield: a VO-TYPED subfield flattens to doubly-prefixed
    // columns (`offer_price_amount`), so its value reconstructs via a nested
    // `new <Vo>(...)`.  The schema, save, and wire sides already recurse —
    // this arm used to read a single non-existent column (`row.offer_price`),
    // a latent tsc break on the VO-in-VO shape.
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    const args = (vo?.fields ?? [])
      .map((f) =>
        hydrateValueExpr(`${fieldName}_${f.name}`, f.type, rowVar, ctx, false, forceNonNull, true),
      )
      .join(", ");
    if (optional) {
      return `(${rowVar}.${firstLeafColumn(fieldName, t.name, ctx)} == null ? null : new ${t.name}(${args}))`;
    }
    return `new ${t.name}(${args})`;
  }
  return colExpr;
}

/** The first LEAF (non-VO) flattened column of a VO field — the null probe
 *  an optional VO field's hydrate guards on.  Recurses through VO-typed
 *  first subfields (`offer` → `offer_price` → `offer_price_amount`). */
function firstLeafColumn(fieldName: string, voName: string, ctx: BoundedContextIR): string {
  const vo = ctx.valueObjects.find((v) => v.name === voName);
  const f = vo?.fields[0];
  if (!f) return fieldName;
  const inner = f.type.kind === "optional" ? f.type.inner : f.type;
  return inner.kind === "valueobject"
    ? firstLeafColumn(`${fieldName}_${f.name}`, inner.name, ctx)
    : `${fieldName}_${f.name}`;
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
