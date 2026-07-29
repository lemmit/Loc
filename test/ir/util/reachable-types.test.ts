import { describe, expect, it } from "vitest";
import type { TypeIR, ValueObjectIR } from "../../../src/ir/types/loom-ir.js";
import { collectReachableTypes } from "../../../src/ir/util/reachable-types.js";

// `collectReachableTypes` computes the transitive VO/enum closure every
// schema/DTO emitter relies on: a reached value object's emitted `<Vo>Schema`
// references the schema of EACH of its field types, so those are reachable
// too.  Getting the closure wrong emits a schema referencing an undeclared
// one ("CountrySchema is not defined").  It's pure graph traversal with the
// classic cycle / off-by-one risk and had no direct test — M-T9.17 slice 1.

const vo = (name: string): TypeIR => ({ kind: "valueobject", name });
const en = (name: string): TypeIR => ({ kind: "enum", name });
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });

const voDef = (name: string, fields: { name: string; type: TypeIR }[]): ValueObjectIR =>
  ({ name, fields }) as unknown as ValueObjectIR;

describe("collectReachableTypes", () => {
  it("collects value objects and enums named directly on the seeds", () => {
    const r = collectReachableTypes([vo("Address"), en("Status"), { kind: "int" } as TypeIR], []);
    expect([...r.valueObjects]).toEqual(["Address"]);
    expect([...r.enums]).toEqual(["Status"]);
  });

  it("descends through array and optional wrappers", () => {
    const r = collectReachableTypes([arr(vo("Line")), opt(en("Kind"))], [voDef("Line", [])]);
    expect([...r.valueObjects]).toEqual(["Line"]);
    expect([...r.enums]).toEqual(["Kind"]);
  });

  it("reaches types transitively through a value object's own fields", () => {
    // Address.country: Country(enum), Address.geo: Geo(vo) → both reachable
    // even though only Address is a seed.
    const r = collectReachableTypes(
      [vo("Address")],
      [
        voDef("Address", [
          { name: "country", type: en("Country") },
          { name: "geo", type: vo("Geo") },
        ]),
        voDef("Geo", [{ name: "unit", type: en("GeoUnit") }]),
      ],
    );
    expect([...r.valueObjects].sort()).toEqual(["Address", "Geo"]);
    expect([...r.enums].sort()).toEqual(["Country", "GeoUnit"]);
  });

  it("terminates on a value-object reference cycle (A → B → A)", () => {
    // The `vos.has` guard must break the cycle; a missing guard loops forever.
    const r = collectReachableTypes(
      [vo("A")],
      [voDef("A", [{ name: "b", type: vo("B") }]), voDef("B", [{ name: "a", type: vo("A") }])],
    );
    expect([...r.valueObjects].sort()).toEqual(["A", "B"]);
    expect([...r.enums]).toEqual([]);
  });

  it("terminates on a self-referential value object (A → A)", () => {
    const r = collectReachableTypes(
      [vo("A")],
      [voDef("A", [{ name: "next", type: opt(vo("A")) }])],
    );
    expect([...r.valueObjects]).toEqual(["A"]);
  });

  it("ignores a field whose value-object type has no definition (leaf)", () => {
    // A referenced VO with no entry in the definitions list is still counted
    // as reached but contributes no further descent (the `if (!vo) continue`).
    const r = collectReachableTypes([vo("Ghost")], []);
    expect([...r.valueObjects]).toEqual(["Ghost"]);
  });

  it("returns empty sets for scalar-only seeds", () => {
    const r = collectReachableTypes([{ kind: "int" } as TypeIR, { kind: "string" } as TypeIR], []);
    expect(r.valueObjects.size).toBe(0);
    expect(r.enums.size).toBe(0);
  });
});
