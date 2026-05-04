import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  TypeIR,
  ValueObjectIR,
} from "../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// Wire-shape — single source of truth for the canonical JSON shape an
// aggregate / part / value object takes on the network.
//
// Three platforms emit code that has to agree on this shape:
//
//   - Hono routes (Zod response schema in routes-builder)
//   - Hono repository (toWire serializer in repository-builder)
//   - .NET DTOs (Response record in dto-mapping)
//   - .NET handler projection (project-to-response in dto-mapping)
//   - React api hooks (Zod response schema in api-builder)
//
// Before this module each path walked the AggregateIR independently
// in the same order (id, fields, contains, derived).  The order is
// the contract — a divergence (forgotten derived, swapped order,
// renamed field) used to surface only at runtime via the cross-
// platform OpenAPI parity diff.  Centralising the walk means
// generators can't drift.
//
// Each generator still renders TypeIR to its own language
// (`zodForResponse`, `wireType`, etc.) — only the `(name, type,
// optional)` tuple list is shared.
// ---------------------------------------------------------------------------

export type WireFieldSource =
  | "id"
  | "property"
  | "containment"
  | "derived";

export interface WireField {
  /** JSON key on the wire.  Stays as the user wrote it in the
   * `.ddd` source — backends that prefer PascalCase / camelCase
   * decide their own casing rule. */
  name: string;
  /** Domain-typed value the wire field carries.  For containment
   * collections, this is `array { element: entity { name } }`; for
   * single containments it's `entity { name }`. */
  type: TypeIR;
  /** True iff the source field was declared `T?`. */
  optional: boolean;
  /** Where the wire field came from in the IR.  Useful for
   * generators that treat parts (containment) differently from
   * primitive fields (e.g., the React frontend skips parts in the
   * create form). */
  source: WireFieldSource;
}

/**
 * Canonical wire field list for an aggregate root.  Order is
 * load-bearing — both backends emit DTOs in this order and the
 * cross-check diff lines up by name.
 *
 *   1. `id`              — always first
 *   2. each `Property`   — declaration order
 *   3. each `Containment` — declaration order, collection vs single
 *   4. each `Derived`    — declaration order, computed server-side
 */
export function wireFieldsForAggregate(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): WireField[] {
  void ctx;
  const out: WireField[] = [
    { name: "id", type: idTypeFor(agg.name), optional: false, source: "id" },
  ];
  for (const f of agg.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
    });
  }
  for (const c of agg.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: false,
      source: "containment",
    });
  }
  for (const d of agg.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: false,
      source: "derived",
    });
  }
  return out;
}

/** Same canonical order, but for an entity part (no aggregate root
 * nuance — parts can themselves contain further parts and have
 * derived members). */
export function wireFieldsForPart(
  part: EntityPartIR,
  ctx: BoundedContextIR,
): WireField[] {
  void ctx;
  const out: WireField[] = [
    { name: "id", type: idTypeFor(part.name), optional: false, source: "id" },
  ];
  for (const f of part.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
    });
  }
  for (const c of part.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: false,
      source: "containment",
    });
  }
  for (const d of part.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: false,
      source: "derived",
    });
  }
  return out;
}

/** Wire fields for a value object.  No `id`, no containment — just
 * declared fields and derived. */
export function wireFieldsForValueObject(
  vo: ValueObjectIR,
  ctx: BoundedContextIR,
): WireField[] {
  void ctx;
  const out: WireField[] = [];
  for (const f of vo.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
    });
  }
  for (const d of vo.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: false,
      source: "derived",
    });
  }
  return out;
}

function idTypeFor(targetName: string): TypeIR {
  // Wire ids are strings on every backend — ungrouped from the
  // underlying Guid / int / long.  Using `id` here keeps generators'
  // Type → wire mapping uniform (a wire-id field hits the same path
  // as `customerId: Id<Customer>`).
  return { kind: "id", targetName, valueType: "guid" };
}

function containmentTypeFor(partName: string, collection: boolean): TypeIR {
  return collection
    ? { kind: "array", element: { kind: "entity", name: partName } }
    : { kind: "entity", name: partName };
}
