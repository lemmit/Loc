// ---------------------------------------------------------------------------
// `src/generator/_frontend/component-prop-type.ts` — the ONE Loom-type → TS
// spelling used for a `component`'s props on all three JS-embedding frontends
// (React `interface XProps`, Vue `defineProps<{…}>`, Svelte `$props()`).
//
// It exists because the three copies had drifted: React's was a stub that
// returned `"string"` for every non-entity param, so `component Badge(level:
// int)` produced `level: string` (TS2365 on `level > 2`, TS2322 on `<Badge
// level={count} />`).  The module's stated contract is therefore twofold:
//
//   * every supported kind gets its DECLARED type's spelling, not `string`;
//   * an unsupported shape THROWS rather than silently emitting `string` —
//     "a prop the frontend cannot type is a generation-time error, not
//     something to paper over".
//
// Both halves are pinned here, kind by kind, plus the `dtoImports` side effect
// (an aggregate param records the `import type { XResponse } from "../api/x"`
// line its caller emits) and `paramPropTsType`'s `action` / `action(T)`
// callback shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  componentPropTsType,
  paramPropTsType,
} from "../../../src/generator/_frontend/component-prop-type.js";
import type { AggregateIR, ParamIR, PrimitiveName, TypeIR } from "../../../src/ir/types/loom-ir.js";

const prim = (name: PrimitiveName): TypeIR => ({ kind: "primitive", name });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });

/** Only `.has` / `.get` on the NAME is read, so a name-keyed stub is the
 *  whole dependency. */
const aggs = (...names: string[]): ReadonlyMap<string, AggregateIR> =>
  new Map(names.map((n) => [n, { name: n } as AggregateIR]));

const noImports = () => new Map<string, string>();

describe("componentPropTsType — scalars", () => {
  it("maps each numeric primitive to `number`, not `string`", () => {
    for (const n of ["int", "long", "decimal"] as PrimitiveName[]) {
      expect(componentPropTsType(prim(n), aggs(), noImports())).toBe("number");
    }
  });

  it("maps bool → boolean, the string-shaped scalars → string, json → unknown", () => {
    expect(componentPropTsType(prim("bool"), aggs(), noImports())).toBe("boolean");
    for (const n of ["string", "datetime", "guid"] as PrimitiveName[]) {
      expect(componentPropTsType(prim(n), aggs(), noImports())).toBe("string");
    }
    expect(componentPropTsType(prim("json"), aggs(), noImports())).toBe("unknown");
  });

  it("maps `X id` and an enum to `string`", () => {
    const id: TypeIR = { kind: "id", targetName: "Order", valueType: "guid" };
    expect(componentPropTsType(id, aggs(), noImports())).toBe("string");
    expect(componentPropTsType({ kind: "enum", name: "Status" }, aggs(), noImports())).toBe(
      "string",
    );
  });
});

describe("componentPropTsType — aggregates and the dtoImports side effect", () => {
  it("types a KNOWN aggregate as its wire DTO and records the import line", () => {
    const imports = noImports();
    expect(componentPropTsType({ kind: "entity", name: "Order" }, aggs("Order"), imports)).toBe(
      "OrderResponse",
    );
    expect([...imports.entries()]).toEqual([["OrderResponse", "../api/order"]]);
  });

  it("falls back to `unknown` for an entity that is not an aggregate — and records NO import", () => {
    const imports = noImports();
    expect(componentPropTsType({ kind: "entity", name: "Line" }, aggs("Order"), imports)).toBe(
      "unknown",
    );
    expect(imports.size).toBe(0);
  });

  it("records the import once even when the aggregate is reached through wrappers", () => {
    const imports = noImports();
    const t = opt(arr({ kind: "entity", name: "Order" }));
    expect(componentPropTsType(t, aggs("Order"), imports)).toBe("OrderResponse[] | undefined");
    expect([...imports.keys()]).toEqual(["OrderResponse"]);
  });
});

describe("componentPropTsType — wrappers", () => {
  it("renders a list as `T[]` and an optional as `T | undefined`", () => {
    expect(componentPropTsType(arr(prim("int")), aggs(), noImports())).toBe("number[]");
    expect(componentPropTsType(opt(prim("string")), aggs(), noImports())).toBe(
      "string | undefined",
    );
  });

  it("nests wrappers in declaration order", () => {
    // `int?[]` canonicalises as optional(array(int)).
    expect(componentPropTsType(opt(arr(prim("int"))), aggs(), noImports())).toBe(
      "number[] | undefined",
    );
    expect(componentPropTsType(arr(arr(prim("bool"))), aggs(), noImports())).toBe("boolean[][]");
  });
});

describe("componentPropTsType — the loud-failure contract", () => {
  it("THROWS on a value-object param rather than emitting `string`", () => {
    expect(() =>
      componentPropTsType({ kind: "valueobject", name: "Address" }, aggs(), noImports()),
    ).toThrow("component prop: unsupported type kind 'valueobject'");
  });

  it("THROWS on a slot param — the call sites handle `slot` before delegating here", () => {
    expect(() => componentPropTsType({ kind: "slot" }, aggs(), noImports())).toThrow(
      "component prop: unsupported type kind 'slot'",
    );
  });

  it("THROWS on a `money` / `File` primitive (see the handed-off defect below)", () => {
    expect(() => componentPropTsType(prim("money"), aggs(), noImports())).toThrow(
      "component prop: unsupported primitive 'money'",
    );
    expect(() => componentPropTsType(prim("File"), aggs(), noImports())).toThrow(
      "component prop: unsupported primitive 'File'",
    );
  });
});

// ---------------------------------------------------------------------------
// DEFECT (handed off, NOT fixed here — this packet is test-only).
//
// `component Tag(v: money)` passes phases ①②③④⑤⑥⑦ — no validator rejects a
// `money` component param — and then CRASHES React codegen:
//
//   Error: component prop: unsupported primitive 'money'.
//     at componentPropTsType (src/generator/_frontend/component-prop-type.ts:60)
//     at propType            (src/generator/react/walker/page-shell.ts:1164)
//     at renderUserComponentFile (src/generator/react/walker/page-shell.ts:1166)
//
// Reproduced against this checkout with a minimal system (aggregate + repo +
// api + `ui { component MoneyTag(v: money) { body: Text { "x" } } }` + a page
// that calls it): `decimal` generates fine, `money` throws.  `File` and
// value-object params are HONEST gaps — phase ④ rejects both, so they never
// reach the emitter; `money` is the hole.
//
// Proposed patch (one arm, `src/generator/_frontend/component-prop-type.ts`,
// inside the `case "primitive"` switch), matching the widened `MoneyValue`
// prop every React/Svelte pack already emits so a money prop can be handed
// straight to the formatter:
//
//     case "money":
//       return "number | string | { toString(): string }";
//
// The alternative — a `loom.component-param-unsupported` validator gate — is
// worse: money in a component body is exactly what a price badge wants.
// ---------------------------------------------------------------------------
describe("componentPropTsType — handed-off defect", () => {
  it.fails("SHOULD type a `money` component param instead of crashing codegen", () => {
    // Expected once the arm above lands; `it.fails` so it flips green with the
    // fix and stays honest (red-as-expected) until then.
    expect(componentPropTsType(prim("money"), aggs(), noImports())).toBe(
      "number | string | { toString(): string }",
    );
  });
});

describe("paramPropTsType — the action callback shape", () => {
  const param = (name: string, type: TypeIR): ParamIR => ({ name, type });

  it("renders a bare `action` as a zero-arg void callback", () => {
    expect(paramPropTsType(param("onPick", { kind: "action" }), aggs(), noImports())).toBe(
      "() => void",
    );
  });

  it("renders `action(T)` as a one-arg void callback, typed by the same data rule", () => {
    const imports = noImports();
    const t: TypeIR = { kind: "action", arg: { kind: "entity", name: "Order" } };
    expect(paramPropTsType(param("onPick", t), aggs("Order"), imports)).toBe(
      "(arg: OrderResponse) => void",
    );
    expect([...imports.keys()]).toEqual(["OrderResponse"]);
    expect(
      paramPropTsType(param("onN", { kind: "action", arg: prim("int") }), aggs(), noImports()),
    ).toBe("(arg: number) => void");
  });

  it("unwraps an OPTIONAL action to the same callback type (the `?` lands on the prop, not the type)", () => {
    const t: TypeIR = { kind: "optional", inner: { kind: "action", arg: prim("string") } };
    expect(paramPropTsType(param("onPick", t), aggs(), noImports())).toBe("(arg: string) => void");
  });

  it("delegates every non-action param straight to componentPropTsType", () => {
    for (const t of [prim("int"), arr(prim("string")), opt(prim("bool"))]) {
      expect(paramPropTsType(param("p", t), aggs(), noImports())).toBe(
        componentPropTsType(t, aggs(), noImports()),
      );
    }
  });
});
