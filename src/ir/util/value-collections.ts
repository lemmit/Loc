import { snake } from "../../util/naming.js";
import type { FieldIR, TypeIR } from "../types/loom-ir.js";

// ---------------------------------------------------------------------------
// Value-object collections — `field: <VO>[]` on an aggregate / entity part.
//
// Unlike a reference collection (`X id[]` → join table) or a contained
// entity collection (`contains X[]` → child table keyed by the element's
// own id), a value-object array holds *identity-less* composites.  It is
// persisted as a child table whose columns are the value object's
// flattened fields, keyed by `(parent_id, ordinal)` — no surrogate id, and
// nothing leaks onto the wire beyond the value object's own shape.
//
// This is plain relational SQL (a child table + FK), so it is portable to
// every SQL backend — the deliberate alternative to a Postgres-only
// `jsonb`/array column.  The descriptor is derived here, once, so every
// backend's schema / repository / migration emitter agrees on the table
// and FK names for a database they share.
// ---------------------------------------------------------------------------

export interface ValueCollectionIR {
  /** Owning field name (`charges`). */
  readonly fieldName: string;
  /** The value-object element type name (`Money`). */
  readonly voName: string;
  /** Child table name, `snake(owner)_snake(field)` — one per field, so two
   *  `Money[]` fields on the same owner never collide. */
  readonly childTable: string;
  /** camelCase const name a backend's ORM binds the table to
   *  (`order_charges` → `orderCharges`).  Derived here so the schema, the
   *  repository, and the migration emitter all reference the same symbol. */
  readonly tableConst: string;
  /** FK column pointing at the owner row, `snake(owner)_id`. */
  readonly parentFk: string;
  /** True iff the field was declared optional (`<VO>[]?`). */
  readonly optional: boolean;
}

/** Unwrap `optional(array(valueobject))` / `array(valueobject)` to the VO
 *  element name, or null when the type is not a value-object collection. */
function valueArrayElement(t: TypeIR): { voName: string; optional: boolean } | null {
  const optional = t.kind === "optional";
  const arr = t.kind === "optional" ? t.inner : t;
  if (arr.kind !== "array") return null;
  const el = arr.element;
  if (el.kind !== "valueobject") return null;
  return { voName: el.name, optional };
}

/** The value-object collection fields of an owner (aggregate or entity
 *  part), each mapped to its id-less child-table descriptor.  Returns an
 *  empty array when the owner declares none. */
export function valueCollectionsFor(owner: {
  name: string;
  fields: readonly FieldIR[];
}): ValueCollectionIR[] {
  const out: ValueCollectionIR[] = [];
  for (const f of owner.fields) {
    const el = valueArrayElement(f.type);
    if (!el) continue;
    const childTable = `${snake(owner.name)}_${snake(f.name)}`;
    out.push({
      fieldName: f.name,
      voName: el.voName,
      childTable,
      tableConst: childTable.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
      parentFk: `${snake(owner.name)}_id`,
      optional: el.optional || f.optional,
    });
  }
  return out;
}

/** True when a field type is a value-object collection (`<VO>[]`, optionally
 *  `<VO>[]?`) — i.e. persisted as an id-less child table, not a root column. */
export function isValueCollectionType(t: TypeIR): boolean {
  return valueArrayElement(t) !== null;
}
