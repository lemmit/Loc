import { describe, expect, it } from "vitest";
import {
  NUMERIC_WIRE_CODEC,
  numericKindOf,
  wireCodecFor,
} from "../../../src/generator/_numeric/codec.js";
import { type NumericTarget, numericEncode } from "../../../src/generator/_numeric/target.js";
import { MONEY_WIRE_SCALE } from "../../../src/generator/money-scale.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";

const prim = (name: TypeIR extends { kind: "primitive"; name: infer N } ? N : never): TypeIR =>
  ({ kind: "primitive", name }) as TypeIR;
const optional = (inner: TypeIR): TypeIR => ({ kind: "optional", inner }) as TypeIR;

describe("numericKindOf", () => {
  it("classifies the four numeric primitives", () => {
    expect(numericKindOf(prim("money"))).toBe("money");
    expect(numericKindOf(prim("decimal"))).toBe("decimal");
    expect(numericKindOf(prim("int"))).toBe("int");
    expect(numericKindOf(prim("long"))).toBe("long");
  });

  it("unwraps optional before classifying", () => {
    expect(numericKindOf(optional(prim("money")))).toBe("money");
    expect(numericKindOf(optional(prim("int")))).toBe("int");
  });

  it("returns null for every non-numeric type", () => {
    expect(numericKindOf(prim("string"))).toBeNull();
    expect(numericKindOf(prim("bool"))).toBeNull();
    expect(numericKindOf(prim("datetime"))).toBeNull();
    expect(numericKindOf(prim("guid"))).toBeNull();
    expect(numericKindOf({ kind: "id", targetName: "Order" } as TypeIR)).toBeNull();
    expect(numericKindOf({ kind: "valueobject", name: "Money" } as TypeIR)).toBeNull();
    expect(numericKindOf({ kind: "array", element: prim("int") } as TypeIR)).toBeNull();
  });
});

describe("wireCodecFor — the decision table (RS-12 / RS-24)", () => {
  it("money is a fixed-scale wire STRING", () => {
    expect(wireCodecFor("money")).toEqual({ wireForm: "string", scale: MONEY_WIRE_SCALE });
    expect(MONEY_WIRE_SCALE).toBe(4);
  });

  it("decimal is a wire NUMBER (no fixed scale — RS-24, float64)", () => {
    expect(wireCodecFor("decimal")).toEqual({ wireForm: "number" });
  });

  it("int and long are wire NUMBERs", () => {
    expect(wireCodecFor("int")).toEqual({ wireForm: "number" });
    expect(wireCodecFor("long")).toEqual({ wireForm: "number" });
  });

  it("is a total table over every NumericKind (four rows, no more, no fewer)", () => {
    expect(Object.keys(NUMERIC_WIRE_CODEC).sort()).toEqual(["decimal", "int", "long", "money"]);
  });
});

describe("numericEncode — the per-backend leaf dispatcher", () => {
  const FAKE_TARGET: NumericTarget = {
    lang: "fake",
    money: {
      "dto-map": (e) => `MONEY(${e})`,
    },
  };

  it("calls the registered leaf for a declared (kind, boundary) pair", () => {
    expect(numericEncode(FAKE_TARGET, "money", "dto-map", "x")).toBe("MONEY(x)");
  });

  it("falls back to identity when the backend declares no leaf for the pair", () => {
    expect(numericEncode(FAKE_TARGET, "money", "repo-read", "x")).toBe("x");
    expect(numericEncode(FAKE_TARGET, "int", "dto-map", "x")).toBe("x");
  });
});
