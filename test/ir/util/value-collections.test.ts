import { describe, expect, it } from "vitest";
import type { FieldIR, TypeIR } from "../../../src/ir/types/loom-ir.js";
import {
  isValueCollectionType,
  valueCollectionsFor,
} from "../../../src/ir/util/value-collections.js";

// `field: <VO>[]` — a collection of identity-less composites, persisted as a
// child table keyed by `(parent_id, ordinal)`.  M-T9.17 slice 4: no test calls
// either export today.
//
// The descriptor is derived ONCE so that every backend's schema, repository and
// migration emitter agrees on the table and FK names for a database they SHARE.
// That is the whole reason it is here rather than per-backend, and it is also
// why the naming rules below are pinned literally: if two backends disagreed
// about `childTable`, one of them would write rows the other cannot read, and
// no single-backend test could see it.
//
// The type predicate is the other half: a value-object array is NOT a reference
// collection (`X id[]` → join table) and NOT a contained entity collection
// (`contains X[]` → child table keyed by the element's own id).  Those three
// take different persistence paths, so each near-miss is asserted alone.

const vo = (name = "Charge"): TypeIR => ({ kind: "valueobject", name });
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });
const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;
const idT = (): TypeIR => ({ kind: "id", targetName: "Tag", valueType: "guid" }) as TypeIR;

const field = (name: string, type: TypeIR, optional = false): FieldIR =>
  ({ name, type, optional }) as unknown as FieldIR;

const owner = (name: string, fields: FieldIR[]) => ({ name, fields });

describe("isValueCollectionType — the three collection shapes are different", () => {
  it("is true for `<VO>[]` and for the optional `<VO>[]?`", () => {
    expect(isValueCollectionType(arr(vo()))).toBe(true);
    expect(isValueCollectionType(opt(arr(vo())))).toBe(true);
  });

  it("is FALSE for a reference collection `X id[]` — that is a join table", () => {
    expect(isValueCollectionType(arr(idT()))).toBe(false);
  });

  it("is FALSE for a contained entity collection — keyed by the child's own id", () => {
    expect(isValueCollectionType(arr({ kind: "entity", name: "Line" }))).toBe(false);
  });

  it("is FALSE for a scalar array and for a bare (non-array) value object", () => {
    // A bare VO flattens into the owner's own columns; only the ARRAY takes a
    // child table.  A predicate that keyed off the element type alone would
    // pull the embedded case onto the wrong path.
    expect(isValueCollectionType(arr(prim("string")))).toBe(false);
    expect(isValueCollectionType(vo())).toBe(false);
  });

  it("does not unwrap TWO levels — `<VO>[]??` is not recognised", () => {
    // One optional level only, matching the lowering: a doubly-wrapped type is
    // not a shape the DSL produces, and silently accepting it would let an
    // unexpected IR shape reach the schema emitter.
    expect(isValueCollectionType(opt(opt(arr(vo()))))).toBe(false);
  });

  it("is FALSE for an optional VO that is not an array (`<VO>?`)", () => {
    expect(isValueCollectionType(opt(vo()))).toBe(false);
  });
});

describe("valueCollectionsFor — the shared child-table descriptor", () => {
  it("returns an empty list for an owner that declares none", () => {
    expect(valueCollectionsFor(owner("Order", []))).toEqual([]);
    expect(valueCollectionsFor(owner("Order", [field("total", prim("money"))]))).toEqual([]);
  });

  it("derives every name from the owner + field, snake-cased", () => {
    const [c] = valueCollectionsFor(owner("Order", [field("lineCharges", arr(vo("Money")))]));
    expect(c).toEqual({
      fieldName: "lineCharges",
      voName: "Money",
      childTable: "order_line_charges",
      tableConst: "orderLineCharges",
      parentFk: "order_id",
      optional: false,
    });
  });

  it("names the child table per FIELD, so two `Money[]` fields never collide", () => {
    // The stated reason for `snake(owner)_snake(field)` rather than
    // `snake(owner)_snake(vo)`: the second spelling gives both fields the same
    // table, and the two collections silently share rows.
    const cs = valueCollectionsFor(
      owner("Order", [field("charges", arr(vo("Money"))), field("refunds", arr(vo("Money")))]),
    );
    expect(cs.map((c) => c.childTable)).toEqual(["order_charges", "order_refunds"]);
    expect(new Set(cs.map((c) => c.childTable)).size).toBe(2);
  });

  it("gives both fields the SAME parent FK — it names the owner, not the field", () => {
    const cs = valueCollectionsFor(
      owner("Order", [field("charges", arr(vo())), field("refunds", arr(vo()))]),
    );
    expect(cs.map((c) => c.parentFk)).toEqual(["order_id", "order_id"]);
  });

  it("camelises `tableConst` from the snake table, digits included", () => {
    // The ORM binds the table to this symbol in three emitters; a mismatch is
    // a missing import, not a wrong query, so it fails loudly — but only if
    // all three derive it here.
    const [c] = valueCollectionsFor(owner("Order", [field("v2Charges", arr(vo()))]));
    expect(c!.childTable).toBe("order_v2_charges");
    expect(c!.tableConst).toBe("orderV2Charges");
  });

  it("skips non-VO-collection fields while keeping the VO ones, in declaration order", () => {
    const cs = valueCollectionsFor(
      owner("Order", [
        field("tags", arr(idT())),
        field("charges", arr(vo("Money"))),
        field("note", prim("string")),
        field("fees", arr(vo("Fee"))),
      ]),
    );
    expect(cs.map((c) => c.fieldName)).toEqual(["charges", "fees"]);
    expect(cs.map((c) => c.voName)).toEqual(["Money", "Fee"]);
  });
});

describe("valueCollectionsFor — `optional` is the OR of two independent spellings", () => {
  // `el.optional || f.optional`.  Optionality can arrive either as the field's
  // own flag or wrapped into the type as `optional(array(vo))`, and the two are
  // set by different lowering paths.  Each disjunct is asserted ALONE: a copy
  // that read only `f.optional` would mark a `<VO>[]?` column NOT NULL, and the
  // first row without it would fail the insert at runtime.

  it("is false when neither spelling says optional", () => {
    const [c] = valueCollectionsFor(owner("Order", [field("charges", arr(vo()), false)]));
    expect(c!.optional).toBe(false);
  });

  it("is true from the TYPE alone — `optional(array(vo))` with `f.optional` false", () => {
    const [c] = valueCollectionsFor(owner("Order", [field("charges", opt(arr(vo())), false)]));
    expect(c!.optional).toBe(true);
  });

  it("is true from the FIELD FLAG alone — a bare array with `f.optional` true", () => {
    const [c] = valueCollectionsFor(owner("Order", [field("charges", arr(vo()), true)]));
    expect(c!.optional).toBe(true);
  });

  it("is true when both say so", () => {
    const [c] = valueCollectionsFor(owner("Order", [field("charges", opt(arr(vo())), true)]));
    expect(c!.optional).toBe(true);
  });

  it("the optional TYPE spelling still yields the same table names", () => {
    // Optionality must not leak into the naming — the two spellings describe
    // the same table, and a name that varied with nullability would give the
    // backends two different tables for one field.
    const [bare] = valueCollectionsFor(owner("Order", [field("charges", arr(vo()))]));
    const [wrapped] = valueCollectionsFor(owner("Order", [field("charges", opt(arr(vo())))]));
    expect(wrapped!.childTable).toBe(bare!.childTable);
    expect(wrapped!.tableConst).toBe(bare!.tableConst);
    expect(wrapped!.parentFk).toBe(bare!.parentFk);
  });
});
