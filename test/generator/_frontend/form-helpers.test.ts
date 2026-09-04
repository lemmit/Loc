// ---------------------------------------------------------------------------
// `src/generator/_frontend/form-helpers.ts` — the react-hook-form emission
// probes every page-level form builder consults BEFORE it writes a line:
//
//   needsController(fields)   → does this form need the `Controller` import?
//                               (true for every input whose `onChange` is NOT
//                               a DOM event: number/money/bool/File, enums,
//                               and an `X id` whose target has a `display`
//                               field — the select variant.)
//   idTargetsInFields(fields) → which aggregates need a `useAll<X>()` hook,
//                               recursing through value objects and arrays.
//   initialValuesTs(fields)   → the `useForm({ defaultValues })` literal.  RHF
//                               warns (uncontrolled → controlled) for ANY
//                               registered field with no default, so the
//                               property that matters is TOTALITY: one entry
//                               per field handed in, never a hole.
//   unwrapOpt / isPrimitiveLike → the shared type probes above are built on.
//
// The probes are pure over hand-built IR, so that is what the fixtures are.
// `renderDefaultSeed` itself is already pinned by `default-seed.test.ts`; what
// is pinned here is that `initialValuesTs` PREFERS a declared default over the
// type-zero seed and still fills every other slot.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  isPrimitiveLike,
  needsController,
  unwrapOpt,
} from "../../../src/generator/_frontend/form-helpers.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  EnumIR,
  ExprIR,
  PrimitiveName,
  TypeIR,
  ValueObjectIR,
} from "../../../src/ir/types/loom-ir.js";

// --- fixture builders ------------------------------------------------------

const prim = (name: PrimitiveName): TypeIR => ({ kind: "primitive", name });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });
const idOf = (targetName: string): TypeIR => ({ kind: "id", targetName, valueType: "guid" });
const enumOf = (name: string): TypeIR => ({ kind: "enum", name });
const voOf = (name: string): TypeIR => ({ kind: "valueobject", name });

const vo = (name: string, fields: { name: string; type: TypeIR; optional: boolean }[]) =>
  ({ name, fields, derived: [], invariants: [], functions: [], tests: [] }) as ValueObjectIR;

const ctxOf = (valueObjects: ValueObjectIR[] = [], enums: EnumIR[] = []): BoundedContextIR =>
  ({ valueObjects, enums }) as unknown as BoundedContextIR;

/** `displayDerived` is the only property the id probe reads — its presence
 *  selects the `<Select>` (Controller) variant over the plain TextInput. */
const agg = (name: string, withDisplay: boolean): AggregateIR =>
  ({
    name,
    ...(withDisplay ? { displayDerived: { name: "label" } as DerivedIR } : {}),
  }) as AggregateIR;

const aggMap = (...list: AggregateIR[]) => new Map(list.map((a) => [a.name, a]));

const f = (type: TypeIR) => ({ type });

// ---------------------------------------------------------------------------
// unwrapOpt / isPrimitiveLike
// ---------------------------------------------------------------------------

describe("unwrapOpt", () => {
  it("peels EXACTLY one `optional` layer", () => {
    expect(unwrapOpt(opt(prim("int")))).toEqual(prim("int"));
    // A doubly-optional type keeps its inner wrapper — the peel is one level,
    // not a recursive strip.  (The IR canonicalises `T?` to a single optional,
    // so a nested one only arises from hand-built IR; pinned because the two
    // behaviours are indistinguishable on the singly-optional types every
    // caller passes, and a silent switch to recursion would change what
    // `isPrimitiveLike` / `needsController` answer for them.)
    expect(unwrapOpt(opt(opt(prim("int"))))).toEqual(opt(prim("int")));
  });

  it("is the identity on a non-optional type — so calling it twice is safe", () => {
    for (const t of [prim("string"), arr(prim("int")), idOf("Order"), enumOf("Status")]) {
      expect(unwrapOpt(t)).toBe(t);
      expect(unwrapOpt(unwrapOpt(t))).toBe(t);
    }
    // Idempotent on a singly-optional type: the second call is a no-op.
    const once = unwrapOpt(opt(prim("int")));
    expect(unwrapOpt(once)).toBe(once);
  });

  it("does NOT peel an array — only the optional wrapper", () => {
    const t = arr(prim("int"));
    expect(unwrapOpt(t)).toBe(t);
    expect(unwrapOpt(opt(arr(prim("int"))))).toEqual(arr(prim("int")));
  });
});

describe("isPrimitiveLike", () => {
  it("is true for primitives, ids and enums — bare or optional", () => {
    for (const t of [prim("string"), prim("money"), idOf("Order"), enumOf("Status")]) {
      expect(isPrimitiveLike(t)).toBe(true);
      expect(isPrimitiveLike(opt(t))).toBe(true);
    }
  });

  it("is false for value objects, arrays and entities", () => {
    for (const t of [
      voOf("Address"),
      arr(prim("int")),
      { kind: "entity", name: "Line" } as TypeIR,
    ]) {
      expect(isPrimitiveLike(t)).toBe(false);
      expect(isPrimitiveLike(opt(t))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// needsController
// ---------------------------------------------------------------------------

describe("needsController — true for exactly the non-DOM-event input set", () => {
  const ctx = ctxOf();
  const none = aggMap();

  it("is true for every numeric / money / bool / File primitive", () => {
    for (const n of ["int", "long", "decimal", "money", "bool", "File"] as PrimitiveName[]) {
      expect(needsController([f(prim(n))], ctx, none)).toBe(true);
      expect(needsController([f(opt(prim(n)))], ctx, none)).toBe(true);
    }
  });

  it("is false for the primitives that register natively as a TextInput", () => {
    for (const n of ["string", "datetime", "guid", "json"] as PrimitiveName[]) {
      expect(needsController([f(prim(n))], ctx, none)).toBe(false);
    }
  });

  it("is true for an enum (a Select)", () => {
    expect(needsController([f(enumOf("Status"))], ctx, none)).toBe(true);
  });

  it("is false for an array — object arrays go through useFieldArray + register", () => {
    expect(needsController([f(arr(prim("int")))], ctx, none)).toBe(false);
    expect(needsController([f(arr(enumOf("Status")))], ctx, none)).toBe(false);
  });

  it("splits `X id` on the TARGET's display field — select (true) vs plain text (false)", () => {
    const withDisplay = aggMap(agg("Product", true));
    const without = aggMap(agg("Product", false));
    expect(needsController([f(idOf("Product"))], ctx, withDisplay)).toBe(true);
    expect(needsController([f(idOf("Product"))], ctx, without)).toBe(false);
    // An unresolvable target is the text variant too — no phantom import.
    expect(needsController([f(idOf("Product"))], ctx, aggMap())).toBe(false);
  });

  it("recurses INTO a value object — a VO carrying one Controller field forces the import", () => {
    const money = vo("Money", [
      { name: "amount", type: prim("decimal"), optional: false },
      { name: "currency", type: prim("string"), optional: false },
    ]);
    const flat = vo("Name", [
      { name: "first", type: prim("string"), optional: false },
      { name: "last", type: prim("string"), optional: false },
    ]);
    expect(needsController([f(voOf("Money"))], ctxOf([money, flat]), none)).toBe(true);
    expect(needsController([f(voOf("Name"))], ctxOf([money, flat]), none)).toBe(false);
    // An unresolvable VO cannot force the import.
    expect(needsController([f(voOf("Ghost"))], ctxOf([money]), none)).toBe(false);
  });

  it("is false for an empty field set, and true as soon as ONE field needs it", () => {
    expect(needsController([], ctx, none)).toBe(false);
    expect(needsController([f(prim("string")), f(prim("int"))], ctx, none)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// idTargetsInFields
// ---------------------------------------------------------------------------

describe("idTargetsInFields", () => {
  const products = agg("Product", true);
  const customers = agg("Customer", false);
  const all = aggMap(products, customers);

  it("collects each referenced aggregate ONCE, in first-seen order", () => {
    const fields = [
      f(idOf("Product")),
      f(prim("string")),
      f(idOf("Customer")),
      f(opt(idOf("Product"))),
    ];
    expect(idTargetsInFields(fields, ctxOf(), all).map((a) => a.name)).toEqual([
      "Product",
      "Customer",
    ]);
  });

  it("recurses through value objects and arrays", () => {
    const line = vo("Line", [
      { name: "product", type: idOf("Product"), optional: false },
      { name: "note", type: prim("string"), optional: false },
    ]);
    expect(idTargetsInFields([f(voOf("Line"))], ctxOf([line]), all).map((a) => a.name)).toEqual([
      "Product",
    ]);
    expect(
      idTargetsInFields([f(arr(idOf("Customer")))], ctxOf([line]), all).map((a) => a.name),
    ).toEqual(["Customer"]);
  });

  it("drops an id whose target is not in scope (no hook can be emitted for it)", () => {
    expect(idTargetsInFields([f(idOf("Ghost"))], ctxOf(), all)).toEqual([]);
  });

  it("names the hook variable off the target's plural", () => {
    expect(idTargetHookVar(products)).toBe("__products");
  });
});

// ---------------------------------------------------------------------------
// initialValuesTs — totality
// ---------------------------------------------------------------------------

describe("initialValuesTs", () => {
  const status: EnumIR = { name: "Status", values: ["Draft", "Open"] };
  const address = vo("Address", [
    { name: "line1", type: prim("string"), optional: false },
    { name: "zip", type: prim("int"), optional: false },
  ]);
  const ctx = ctxOf([address], [status]);

  /** Split `{ a: X, b: Y }` back into entries — the object literal is flat by
   *  construction except for nested VO braces, which this keeps intact. */
  const entryNames = (literal: string): string[] =>
    [...literal.matchAll(/(?:\{ |, )(\w+): /g)]
      .map((m) => m[1] as string)
      // A nested VO literal contributes its own inner keys; keep only the
      // outer ones by matching against the field list at the call site.
      .filter((k, i, xs) => xs.indexOf(k) === i);

  it("emits a value for EVERY field it is handed — no hole", () => {
    const fields = [
      { name: "title", type: prim("string"), optional: false },
      { name: "qty", type: prim("int"), optional: false },
      { name: "weight", type: prim("decimal"), optional: false },
      { name: "total", type: prim("money"), optional: false },
      { name: "active", type: prim("bool"), optional: false },
      { name: "at", type: prim("datetime"), optional: false },
      { name: "ref", type: prim("guid"), optional: false },
      { name: "blob", type: prim("json"), optional: false },
      { name: "doc", type: prim("File"), optional: false },
      { name: "product", type: idOf("Product"), optional: false },
      { name: "status", type: enumOf("Status"), optional: false },
      { name: "address", type: voOf("Address"), optional: false },
      { name: "tags", type: arr(prim("string")), optional: false },
      { name: "note", type: opt(prim("string")), optional: true },
      { name: "count", type: opt(prim("int")), optional: true },
    ];
    const literal = initialValuesTs(fields, ctx);
    for (const fld of fields) {
      // Present, and bound to something non-empty (`name: ` followed by a
      // value, never `name: ,` or a missing key).
      expect(literal).toMatch(new RegExp(`\\b${fld.name}: [^,}]`));
    }
    expect(entryNames(literal)).toEqual(expect.arrayContaining(fields.map((x) => x.name)));
  });

  it("uses the type-zero seed each input control can hold", () => {
    const one = (name: string, type: TypeIR, optional = false) =>
      initialValuesTs([{ name, type, optional }], ctx);
    expect(one("s", prim("string"))).toBe('{ s: "" }');
    expect(one("n", prim("int"))).toBe("{ n: 0 }");
    expect(one("m", prim("money"))).toBe('{ m: new Decimal("0") }');
    expect(one("b", prim("bool"))).toBe("{ b: false }");
    expect(one("d", prim("datetime"))).toBe('{ d: "" }');
    // No file uploaded yet is a valid initial state — null, not a zero FileRef.
    expect(one("doc", prim("File"))).toBe("{ doc: null }");
    expect(one("p", idOf("Product"))).toBe('{ p: "" }');
    expect(one("tags", arr(prim("string")))).toBe("{ tags: [] }");
  });

  it('seeds an enum with its FIRST declared member, and `""` when the enum is out of scope', () => {
    expect(initialValuesTs([{ name: "st", type: enumOf("Status"), optional: false }], ctx)).toBe(
      '{ st: "Draft" }',
    );
    expect(initialValuesTs([{ name: "st", type: enumOf("Ghost"), optional: false }], ctx)).toBe(
      '{ st: "" }',
    );
  });

  it("expands a value object into a nested literal covering every member", () => {
    expect(initialValuesTs([{ name: "addr", type: voOf("Address"), optional: false }], ctx)).toBe(
      '{ addr: { line1: "", zip: 0 } }',
    );
    // An unresolvable VO still gets a value (an empty object), not a hole.
    expect(initialValuesTs([{ name: "addr", type: voOf("Ghost"), optional: false }], ctx)).toBe(
      "{ addr: {} }",
    );
  });

  it("seeds an OPTIONAL primitive as null (RHF still needs a controlled value)", () => {
    expect(
      initialValuesTs([{ name: "note", type: opt(prim("string")), optional: true }], ctx),
    ).toBe("{ note: null }");
    expect(initialValuesTs([{ name: "n", type: opt(prim("int")), optional: true }], ctx)).toBe(
      "{ n: null }",
    );
  });

  it("PREFERS a declared default over the type-zero seed, and falls back when it is not client-evaluable", () => {
    const draft: ExprIR = { kind: "literal", lit: "string", value: "draft" } as unknown as ExprIR;
    expect(
      initialValuesTs([{ name: "st", type: prim("string"), optional: false, default: draft }], ctx),
    ).toBe('{ st: "draft" }');
    // `now()` is not renderable client-side (`renderDefaultSeed` → null), so
    // the type-zero seed still fills the slot rather than leaving a hole.
    const now: ExprIR = { kind: "literal", lit: "now", value: "now" } as unknown as ExprIR;
    expect(
      initialValuesTs([{ name: "at", type: prim("datetime"), optional: false, default: now }], ctx),
    ).toBe('{ at: "" }');
  });

  it("emits `{  }` for an empty field set", () => {
    expect(initialValuesTs([], ctx)).toBe("{  }");
  });
});
