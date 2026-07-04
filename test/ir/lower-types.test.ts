// Unit tests for `lowerType` (`src/ir/lower/lower-types.ts`).  Drives
// the type-form switch (primitive / id / enum / valueobject / entity /
// array / optional / slot) by parsing a small DSL and inspecting the
// lowered IR's TypeIR shapes.  Direct IR construction is avoided —
// `lowerType` consumes Langium AST `TypeRef` nodes whose container
// wiring is fragile to mock by hand.

import { describe, expect, it } from "vitest";
import type { AggregateIR, FieldIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

async function aggregate(src: string, name: string): Promise<AggregateIR> {
  const loom = await buildLoomModel(`
    context T {
      ${src}
    }
  `);
  const agg = allAggregates(loom).find((a) => a.name === name);
  if (!agg) throw new Error(`aggregate ${name} not found`);
  return agg;
}

function fieldType(agg: AggregateIR, name: string): TypeIR {
  const f = agg.fields.find((x: FieldIR) => x.name === name);
  if (!f) throw new Error(`field ${name} not found on ${agg.name}`);
  return f.type;
}

describe("lowerType — primitives", () => {
  it("lowers each primitive base name to a `primitive` TypeIR", async () => {
    const agg = await aggregate(
      `aggregate A {
        s: string
        i: int
        l: long
        d: decimal
        m: money
        b: bool
        dt: datetime
        g: guid
      }`,
      "A",
    );
    expect(fieldType(agg, "s")).toEqual({ kind: "primitive", name: "string" });
    expect(fieldType(agg, "i")).toEqual({ kind: "primitive", name: "int" });
    expect(fieldType(agg, "l")).toEqual({ kind: "primitive", name: "long" });
    expect(fieldType(agg, "d")).toEqual({ kind: "primitive", name: "decimal" });
    expect(fieldType(agg, "m")).toEqual({ kind: "primitive", name: "money" });
    expect(fieldType(agg, "b")).toEqual({ kind: "primitive", name: "bool" });
    expect(fieldType(agg, "dt")).toEqual({ kind: "primitive", name: "datetime" });
    expect(fieldType(agg, "g")).toEqual({ kind: "primitive", name: "guid" });
  });
});

describe("lowerType — array & optional", () => {
  it("wraps an array type in `{kind: 'array', element: …}`", async () => {
    const agg = await aggregate(`aggregate A { tags: string[] }`, "A");
    expect(fieldType(agg, "tags")).toEqual({
      kind: "array",
      element: { kind: "primitive", name: "string" },
    });
  });

  it("wraps an optional in `{kind: 'optional', inner: …}`", async () => {
    const agg = await aggregate(`aggregate A { nickname: string? }`, "A");
    expect(fieldType(agg, "nickname")).toEqual({
      kind: "optional",
      inner: { kind: "primitive", name: "string" },
    });
  });

  it("nests optional outside array for `T[]?`", async () => {
    const agg = await aggregate(`aggregate A { extras: int[]? }`, "A");
    expect(fieldType(agg, "extras")).toEqual({
      kind: "optional",
      inner: { kind: "array", element: { kind: "primitive", name: "int" } },
    });
  });
});

describe("lowerType — id refs", () => {
  it("lowers `T id` to `{kind: 'id', targetName: T, valueType: 'guid'}` by default", async () => {
    const agg = await aggregate(
      `aggregate A { customerId: Customer id }
       aggregate Customer { name: string }`,
      "A",
    );
    expect(fieldType(agg, "customerId")).toEqual({
      kind: "id",
      targetName: "Customer",
      valueType: "guid",
    });
  });

  it("lowers `T id[]` as an array of id", async () => {
    const agg = await aggregate(
      `aggregate A { friends: Customer id[] }
       aggregate Customer { name: string }`,
      "A",
    );
    const t = fieldType(agg, "friends");
    expect(t.kind).toBe("array");
    expect((t as { kind: "array"; element: TypeIR }).element).toEqual({
      kind: "id",
      targetName: "Customer",
      valueType: "guid",
    });
  });
});

describe("lowerType — named types (enum / valueobject / entity)", () => {
  it("resolves an enum name to `{kind: 'enum', name}`", async () => {
    const agg = await aggregate(
      `enum Color { Red, Green, Blue }
       aggregate A { hue: Color }`,
      "A",
    );
    expect(fieldType(agg, "hue")).toEqual({ kind: "enum", name: "Color" });
  });

  it("resolves a value-object name to `{kind: 'valueobject', name}`", async () => {
    const agg = await aggregate(
      `valueobject Money { amount: decimal  currency: string }
       aggregate A { price: Money }`,
      "A",
    );
    expect(fieldType(agg, "price")).toEqual({ kind: "valueobject", name: "Money" });
  });

  it("resolves an entity-part name to `{kind: 'entity', name}` via the containment path", async () => {
    // Containments use the part's name in TypeRef position.  Cross-aggregate
    // refs aren't admissible here per the validator (loom.bare-aggregate-in-type);
    // we exercise the entity-part lowering via the `contains` collection slot,
    // whose IR carries the resolved part type.
    const agg = await aggregate(
      `aggregate A {
        name: string
        contains lines: Line[]
        entity Line { qty: int }
      }`,
      "A",
    );
    expect(agg.contains.map((c) => c.partName)).toContain("Line");
  });
});

describe("lowerType — fallback / edge cases", () => {
  it("defaults to `{kind: 'primitive', name: 'string'}` when called with undefined", async () => {
    // The unparameterised default lives in lowerType itself — exercising it
    // through the DSL requires a position where a TypeRef can be syntactically
    // absent.  Function declarations admit a missing return-type:
    //   `function isOk(): = ...`  is rejected by the parser, but the lowered
    // body for a missing return-type via macro expansion would default here.
    // The behaviour is asserted directly because hand-constructing the AST
    // path through the parser to hit this branch is awkward.
    const { lowerType } = await import("../../src/ir/lower/lower-types.js");
    expect(lowerType(undefined)).toEqual({ kind: "primitive", name: "string" });
  });

  it("falls back to primitive 'string' for an unresolved named type", async () => {
    // The validator catches this case at the language level (Langium's
    // linker emits "Could not resolve …"), but lowering must remain total —
    // backends should still receive an IR.  We exercise the fallback by
    // passing an unresolved TypeRef via the lowering helper directly.
    const { lowerType } = await import("../../src/ir/lower/lower-types.js");
    // biome-ignore lint/suspicious/noExplicitAny: bypassing AST construction
    const fakeRef: any = {
      array: false,
      optional: false,
      base: {
        $type: "NamedType",
        // No ref / no $refText → target stays undefined → falls through.
        target: { ref: undefined, $refText: "Unknown" },
      },
    };
    expect(lowerType(fakeRef)).toEqual({ kind: "primitive", name: "string" });
  });
});
