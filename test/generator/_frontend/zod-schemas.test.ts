// ---------------------------------------------------------------------------
// `src/generator/_frontend/zod-schemas.ts` — the framework-neutral wire-schema
// emitter shared by React and Svelte (both emit byte-identical zod
// request/response/VO/enum/union schemas; only the fetching layer differs).
//
// What this file pins, and why each pin exists:
//
//  1. THE REQUEST/RESPONSE DIVERGENCE SET.  `zodForRequest` and
//     `zodForResponse` are two tables over the same `WirePrimitive` keys, and
//     the whole contract is "they agree except where the wire genuinely
//     differs".  The set of primitives where they disagree is asserted
//     WHOLESALE (`["File"]`) rather than one `toBe` per row, so widening it —
//     including making `money` diverge — fails, and so does silently
//     collapsing the one divergence that is real.
//
//     Note on money (M-T9.24 **F1b**): money IS the one wire type whose
//     `z.input` ≠ `z.output`, but that asymmetry is a property of the
//     `moneySchema` TRANSFORM, not of this module's two tables — both sides
//     emit the identical symbol `moneySchema`.  The divergence therefore
//     surfaces one layer up, in the TYPE aliases (`<Req>FormState` = `z.input`
//     vs `<Req>` = `z.output`) that make the scaffolded form emit the RHF
//     three-generic `useForm<FormState, unknown, Request>`.  Pinning "money is
//     TEXTUALLY symmetric here" is the honest statement of that split, and it
//     is asserted explicitly below so a future edit that makes money diverge
//     in this module has to justify itself against a red test.
//
//  2. `provenancedZod`'s carrier shape reads its member names/order from
//     `_payload/provenanced-wire.ts`, never re-spelled here.
//  3. `emitObjectWithRefines`' two-bucket split — a recognised single-field
//     shape folds NATIVELY into the field's chain, everything else becomes a
//     `.refine(…, { path })` — plus the `message`-forces-a-refine carve-out.
//  4. `emitUnionSchema` takes its discriminator key from
//     `discriminatedUnionZod` in `_payload/union-wire.ts` (the tagged-wire
//     single source of truth), not from a local `"type"` literal.
//  5. `emitEnumSchema` lists EVERY declared value, in declaration order.
//
// Fixtures are hand-built IR typed against `src/ir/types/loom-ir.ts` — these
// are pure string emitters, so a `.ddd` round-trip would only add noise.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  AUDIT_ENTRY_LIST_TYPE,
  emitAuditEntrySchemas,
  emitEnumSchema,
  emitObjectWithRefines,
  emitUnionSchema,
  emitValueObjectSchema,
  preconditionsAsInvariants,
  provenancedZod,
  zodForRequest,
  zodForResponse,
} from "../../../src/generator/_frontend/zod-schemas.js";
import {
  PROVENANCE_LINEAGE_FIELD,
  PROVENANCE_VALUE_FIELD,
  PROVENANCED_REQUEST_ERROR,
  PROVENANCED_WIRE_MEMBERS,
} from "../../../src/generator/_payload/provenanced-wire.js";
import { discriminatedUnionZod, unionMembers } from "../../../src/generator/_payload/union-wire.js";
import type {
  BoundedContextIR,
  EnumIR,
  ExprIR,
  InvariantIR,
  OperationIR,
  PrimitiveName,
  TypeIR,
  ValueObjectIR,
} from "../../../src/ir/types/loom-ir.js";
import {
  AUDIT_ENTRY_TYPE,
  AUDIT_FIELD_CHANGE_TYPE,
  auditEntryWireShape,
  auditFieldChangeWireShape,
} from "../../../src/ir/util/audit-history.js";

// --- fixture builders ------------------------------------------------------

const prim = (name: PrimitiveName): TypeIR => ({ kind: "primitive", name });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });

const field = (name: string, type: TypeIR, optional = false) => ({ name, type, optional });

const vo = (name: string, fields: ReturnType<typeof field>[], invariants: InvariantIR[] = []) =>
  ({ name, fields, derived: [], invariants, functions: [], tests: [] }) as ValueObjectIR;

const ctxOf = (valueObjects: ValueObjectIR[] = []): BoundedContextIR =>
  ({
    aggregates: [],
    valueObjects,
    enums: [],
    payloads: [],
  }) as unknown as BoundedContextIR;

const fieldRef = (name: string): ExprIR =>
  ({ kind: "ref", name, refKind: "this-prop" }) as unknown as ExprIR;
const intLit = (v: number): ExprIR =>
  ({ kind: "literal", lit: "int", value: String(v) }) as unknown as ExprIR;
const bin = (op: string, left: ExprIR, right: ExprIR): ExprIR =>
  ({ kind: "binary", op, left, right }) as unknown as ExprIR;

/** Every primitive that can legally reach a wire field.  `duration` is
 *  deliberately absent — it is expression-only and `wireTypeInfo` throws on
 *  it (see `src/ir/types/wire-types.ts`). */
const WIRE_PRIMITIVES: PrimitiveName[] = [
  "int",
  "long",
  "decimal",
  "money",
  "string",
  "bool",
  "datetime",
  "guid",
  "json",
  "File",
];

// ---------------------------------------------------------------------------
// zodForRequest vs zodForResponse — the divergence set
// ---------------------------------------------------------------------------

describe("zodForRequest / zodForResponse — where the two wire sides diverge", () => {
  it("diverges on EXACTLY one primitive — File — and agrees on every other", () => {
    const diverging = WIRE_PRIMITIVES.filter(
      (name) => zodForRequest(prim(name)) !== zodForResponse(prim(name), false),
    );
    // Whole-set assertion, not per-row: adding a divergence (e.g. making
    // `money` request-only) OR removing File's fails here.
    expect(diverging).toEqual(["File"]);
  });

  it("File: the REQUEST form is the response form plus `.nullable()` (an empty form has no file yet)", () => {
    const response = zodForResponse(prim("File"), false);
    expect(zodForRequest(prim("File"))).toBe(`${response}.nullable()`);
    // And the response side really is the bare FileRef object — a resolved
    // ref the server always returns.
    expect(response).not.toContain("nullable");
    expect(response).toContain("url: z.string()");
  });

  it("money is TEXTUALLY symmetric — both sides emit `moneySchema` (F1b lives in the type aliases, not here)", () => {
    // `moneySchema` is a TRANSFORM, so `z.input` (string | Decimal) ≠
    // `z.output` (Decimal).  That asymmetry is why the scaffolded form emits
    // the RHF three-generic `useForm<FormState, unknown, Request>` — but the
    // SCHEMA TEXT this module emits is the same symbol on both sides.  Pinned
    // so nobody "fixes" F1b by forking the two tables here.
    expect(zodForRequest(prim("money"))).toBe("moneySchema");
    expect(zodForResponse(prim("money"), false)).toBe("moneySchema");
  });

  it("agrees on the numeric / scalar primitives that must match field-for-field", () => {
    for (const name of ["int", "long", "decimal", "string", "bool", "datetime", "guid", "json"]) {
      expect(zodForRequest(prim(name as PrimitiveName))).toBe(
        zodForResponse(prim(name as PrimitiveName), false),
      );
    }
    expect(zodForRequest(prim("int"))).toBe("z.number().int()");
    expect(zodForRequest(prim("bool"))).toBe("z.boolean()");
    expect(zodForRequest(prim("json"))).toBe("z.unknown()");
  });

  it("id: the request side narrows a GUID-keyed reference to `.uuid()`, the response side never does", () => {
    const guidId: TypeIR = { kind: "id", targetName: "Order", valueType: "guid" };
    const intId: TypeIR = { kind: "id", targetName: "Order", valueType: "int" };
    expect(zodForRequest(guidId)).toBe("z.string().uuid()");
    // Schemathesis F2: an int/long/string-keyed aggregate is NOT a uuid.
    expect(zodForRequest(intId)).toBe("z.string()");
    expect(zodForResponse(guidId, false)).toBe("z.string()");
    expect(zodForResponse(intId, false)).toBe("z.string()");
  });

  it("entity: opaque on the request side, the named DTO on the response side", () => {
    const ent: TypeIR = { kind: "entity", name: "Line" };
    expect(zodForRequest(ent)).toBe("z.unknown()");
    expect(zodForResponse(ent, false)).toBe("LineResponse");
  });

  it("enum / value object: the same `<Name>Schema` reference on both sides", () => {
    const en: TypeIR = { kind: "enum", name: "Status" };
    const v: TypeIR = { kind: "valueobject", name: "Address" };
    expect(zodForRequest(en)).toBe("StatusSchema");
    expect(zodForResponse(en, false)).toBe("StatusSchema");
    expect(zodForRequest(v)).toBe("AddressSchema");
    expect(zodForResponse(v, false)).toBe("AddressSchema");
  });

  it("wrappers peel identically on both sides — optional → `.nullish()`, array → `z.array(...)`", () => {
    expect(zodForRequest(opt(prim("int")))).toBe("z.number().int().nullish()");
    expect(zodForResponse(prim("int"), true)).toBe("z.number().int().nullish()");
    expect(zodForRequest(arr(prim("string")))).toBe("z.array(z.string())");
    expect(zodForResponse(arr(prim("string")), false)).toBe("z.array(z.string())");
    // `T?[]` canonicalises as optional(array(T)).
    expect(zodForRequest(opt(arr(prim("string"))))).toBe("z.array(z.string()).nullish()");
  });

  it("Provenanced<T> is response-only — the request side throws the one shared message", () => {
    const carrier: TypeIR = { kind: "genericInstance", ctor: "provenanced", arg: prim("int") };
    expect(() => zodForRequest(carrier)).toThrow(PROVENANCED_REQUEST_ERROR);
    expect(zodForResponse(carrier, false)).toBe(provenancedZod("z.number().int()"));
  });
});

// ---------------------------------------------------------------------------
// provenancedZod
// ---------------------------------------------------------------------------

describe("provenancedZod", () => {
  it("wraps the value zod in the carrier, with a nullish lineage", () => {
    expect(provenancedZod("z.number().int()")).toBe(
      "z.object({ value: z.number().int(), lineage: provLineageSchema.nullish() })",
    );
  });

  it("takes its member names and their ORDER from the shared carrier shape", () => {
    const emitted = provenancedZod("z.string()");
    const keys = [...emitted.matchAll(/(\w+):/g)]
      .map((m) => m[1] as string)
      // `z.object({` contributes no key; the inner `value:` / `lineage:` do.
      .filter((k) => PROVENANCED_WIRE_MEMBERS.includes(k));
    expect(keys).toEqual([...PROVENANCED_WIRE_MEMBERS]);
    expect(PROVENANCED_WIRE_MEMBERS).toEqual([PROVENANCE_VALUE_FIELD, PROVENANCE_LINEAGE_FIELD]);
  });

  it("nests — a provenanced collection carries the array inside the carrier", () => {
    const carrier: TypeIR = {
      kind: "genericInstance",
      ctor: "provenanced",
      arg: arr(prim("string")),
    };
    expect(zodForResponse(carrier, false)).toBe(provenancedZod("z.array(z.string())"));
  });
});

// ---------------------------------------------------------------------------
// emitEnumSchema
// ---------------------------------------------------------------------------

describe("emitEnumSchema", () => {
  it("lists EVERY declared value, in declaration order", () => {
    const e: EnumIR = { name: "Status", values: ["Draft", "Open", "Paid", "Closed"] };
    expect(emitEnumSchema(e)).toEqual([
      'export const StatusSchema = z.enum(["Draft", "Open", "Paid", "Closed"]);',
    ]);
    // Property form: no value may be dropped.
    const emitted = emitEnumSchema(e)[0] as string;
    for (const v of e.values) expect(emitted).toContain(`"${v}"`);
  });

  it("emits a single-value enum without a trailing separator", () => {
    expect(emitEnumSchema({ name: "Only", values: ["One"] })).toEqual([
      'export const OnlySchema = z.enum(["One"]);',
    ]);
  });
});

// ---------------------------------------------------------------------------
// emitObjectWithRefines / emitValueObjectSchema / preconditionsAsInvariants
// ---------------------------------------------------------------------------

describe("emitObjectWithRefines", () => {
  const fields = [
    { name: "qty", base: "z.number().int()" },
    { name: "note", base: "z.string()" },
  ];
  const available = new Set(["qty", "note"]);

  it("with no invariants emits a bare z.object, one line per field", () => {
    expect(emitObjectWithRefines("CreateOrderRequest", fields, [], available)).toEqual([
      "export const CreateOrderRequest = z.object({",
      "  qty: z.number().int(),",
      "  note: z.string(),",
      "});",
    ]);
  });

  it("FOLDS a recognised single-field shape into that field's native chain (no refine)", () => {
    const inv: InvariantIR = { expr: bin(">=", fieldRef("qty"), intLit(1)), source: "qty >= 1" };
    const out = emitObjectWithRefines("CreateOrderRequest", fields, [inv], available);
    expect(out).toContain("  qty: z.number().int().min(1),");
    // Absorbed — it must NOT be double-applied as a refine as well.
    expect(out.join("\n")).not.toContain(".refine(");
    expect(out.at(-1)).toBe("});");
  });

  it("folds MULTIPLE patterns onto the same field, native chains before code-point len refines", () => {
    const invs: InvariantIR[] = [
      { expr: bin(">=", fieldRef("qty"), intLit(1)), source: "qty >= 1" },
      { expr: bin("<=", fieldRef("qty"), intLit(9)), source: "qty <= 9" },
    ];
    const out = emitObjectWithRefines("CreateOrderRequest", fields, invs, available);
    expect(out).toContain("  qty: z.number().int().min(1).max(9),");
  });

  it("emits a cross-field rule as a `.refine(…, { path })` chain on the OBJECT", () => {
    const inv: InvariantIR = {
      expr: bin("<=", fieldRef("qty"), fieldRef("note")),
      source: "qty <= note",
    };
    const out = emitObjectWithRefines("CreateOrderRequest", fields, [inv], available);
    const tail = out.at(-1) as string;
    expect(tail.startsWith("})")).toBe(true);
    expect(tail).toContain(".refine((data: any) => data.qty <= data.note");
    // The path is the first field ref — RHF surfaces the error next to it.
    expect(tail).toContain('path: ["qty"]');
    expect(tail).toContain('message: "Invariant violated: qty <= note"');
    // No field line was touched.
    expect(out).toContain("  qty: z.number().int(),");
  });

  it("a `message` clause KEEPS a single-field rule on the refine carrier (the chain has no message slot)", () => {
    const inv: InvariantIR = {
      expr: bin(">=", fieldRef("qty"), intLit(1)),
      source: "qty >= 1",
      message: { text: "At least one, please" },
    };
    const out = emitObjectWithRefines("CreateOrderRequest", fields, [inv], available);
    expect(out).toContain("  qty: z.number().int(),"); // NOT folded
    expect(out.at(-1)).toContain('message: "At least one, please"');
    expect(out.at(-1)).toContain("loomCode");
  });

  it("drops an invariant whose field is not in the request body (neither chain nor refine)", () => {
    const inv: InvariantIR = {
      expr: bin(">=", fieldRef("total"), intLit(1)),
      source: "total >= 1",
    };
    const out = emitObjectWithRefines(
      "CreateOrderRequest",
      fields,
      [inv],
      new Set(["qty", "note"]),
    );
    expect(out.join("\n")).not.toContain("refine");
    expect(out.join("\n")).not.toContain("total");
  });

  it("a `@server-only` invariant never reaches the wire schema", () => {
    const inv: InvariantIR = {
      expr: bin(">=", fieldRef("qty"), intLit(1)),
      source: "qty >= 1",
      scope: "server-only",
    };
    const out = emitObjectWithRefines("CreateOrderRequest", fields, [inv], available);
    expect(out).toContain("  qty: z.number().int(),");
    expect(out.join("\n")).not.toContain("refine");
  });
});

describe("emitValueObjectSchema", () => {
  it("emits one entry per field, using the RESPONSE spelling of each type", () => {
    const address = vo("Address", [
      field("line1", prim("string")),
      field("zip", opt(prim("string"))),
      field("country", { kind: "enum", name: "Country" }),
    ]);
    expect(emitValueObjectSchema(address)).toEqual([
      "export const AddressSchema = z.object({",
      "  line1: z.string(),",
      "  zip: z.string().nullish(),",
      "  country: CountrySchema,",
      "});",
    ]);
  });

  it("routes its invariants through the same fold/refine split", () => {
    const money = vo(
      "Qty",
      [field("amount", prim("int"))],
      [{ expr: bin(">=", fieldRef("amount"), intLit(0)), source: "amount >= 0" }],
    );
    expect(emitValueObjectSchema(money)).toContain("  amount: z.number().int().min(0),");
  });
});

describe("preconditionsAsInvariants", () => {
  it("lifts precondition statements only, carrying source + message through", () => {
    const op = {
      statements: [
        { kind: "precondition", expr: fieldRef("qty"), source: "qty", message: { text: "nope" } },
        { kind: "assign", target: fieldRef("qty"), value: intLit(1), source: "qty := 1" },
        { kind: "precondition", expr: fieldRef("note"), source: "note" },
      ],
    } as unknown as OperationIR;
    const lifted = preconditionsAsInvariants(op);
    expect(lifted).toHaveLength(2);
    expect(lifted.map((i) => i.source)).toEqual(["qty", "note"]);
    expect(lifted[0]?.message).toEqual({ text: "nope" });
    expect(lifted[1]?.message).toBeUndefined();
  });

  it("returns an empty list for a body with no preconditions", () => {
    const op = {
      statements: [{ kind: "assign", target: fieldRef("qty"), value: intLit(1), source: "x" }],
    } as unknown as OperationIR;
    expect(preconditionsAsInvariants(op)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// emitUnionSchema — the tagged wire
// ---------------------------------------------------------------------------

describe("emitUnionSchema", () => {
  const ctx = ctxOf([vo("Money2", [field("amount", prim("decimal"))])]);

  it("uses the discriminator key from `_payload/union-wire.ts`, not a local literal", () => {
    // The tagged-wire key is owned by `discriminatedUnionZod` — read it back
    // out of that function rather than re-spelling `"type"` here, so a change
    // to the shared shape moves this pin with it.
    const key = /z\.discriminatedUnion\((".*?")/.exec(discriminatedUnionZod([]))?.[1];
    expect(key).toBe('"type"');
    const [decl] = emitUnionSchema("StringOrNone", [prim("string"), { kind: "none" }], ctx);
    expect(decl).toContain(`z.discriminatedUnion(${key}, [`);
  });

  it("scalar variants wrap a `value`; the `none` unit is bare", () => {
    expect(emitUnionSchema("StringOrNone", [prim("string"), { kind: "none" }], ctx)).toEqual([
      'export const StringOrNone = z.discriminatedUnion("type", [z.object({ type: z.literal("string"), value: z.string() }), z.object({ type: z.literal("none") })]);',
      "export type StringOrNone = z.infer<typeof StringOrNone>;",
    ]);
  });

  it("record variants FLATTEN their wire fields alongside the tag", () => {
    const variants: TypeIR[] = [{ kind: "valueobject", name: "Money2" }, { kind: "none" }];
    const [decl] = emitUnionSchema("Money2OrNone", variants, ctx);
    expect(decl).toContain('z.object({ type: z.literal("Money2"), amount: z.number() })');
    // The member list is the shared resolver's, not a local re-derivation.
    expect(unionMembers(variants, ctx).map((m) => m.tag)).toEqual(["Money2", "none"]);
  });

  it("emits the inferred type alias alongside the schema", () => {
    const out = emitUnionSchema("StringOrNone", [prim("string"), { kind: "none" }], ctx);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("export type StringOrNone = z.infer<typeof StringOrNone>;");
  });
});

// ---------------------------------------------------------------------------
// emitAuditEntrySchemas
// ---------------------------------------------------------------------------

describe("emitAuditEntrySchemas", () => {
  const out = emitAuditEntrySchemas();
  const text = out.join("\n");

  it("declares the field-change schema with EXACTLY the shared wire shape's keys", () => {
    for (const f of auditFieldChangeWireShape()) {
      expect(text).toContain(`  ${f.name}: `);
    }
    expect(text).toContain(`export const ${AUDIT_FIELD_CHANGE_TYPE} = z.object({`);
  });

  it("declares the entry schema with EXACTLY the shared wire shape's keys, in order", () => {
    const entryBody = text.slice(text.indexOf(`export const ${AUDIT_ENTRY_TYPE} = z.object({`));
    const keys = [...entryBody.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
    expect(keys).toEqual(auditEntryWireShape().map((f) => f.name));
  });

  it("narrows the entry's `changes` to the field-change schema (the wire shape says json[])", () => {
    // The one deliberate narrowing: `TypeIR` has no nested-record leaf, so the
    // wire shape types `changes` as `json[]`; a `z.array(z.unknown())` would
    // make `__c.field` an error in every frontend's Timeline.
    expect(auditEntryWireShape().find((f) => f.name === "changes")?.type).toEqual({
      kind: "array",
      element: { kind: "primitive", name: "json" },
    });
    expect(text).toContain(`  changes: z.array(${AUDIT_FIELD_CHANGE_TYPE}),`);
  });

  it("emits the LIST response alias every client emitter reaches for by name", () => {
    expect(AUDIT_ENTRY_LIST_TYPE).toBe(`${AUDIT_ENTRY_TYPE}ListResponse`);
    expect(text).toContain(`export const ${AUDIT_ENTRY_LIST_TYPE} = z.array(${AUDIT_ENTRY_TYPE});`);
    expect(text).toContain(
      `export type ${AUDIT_ENTRY_LIST_TYPE} = z.infer<typeof ${AUDIT_ENTRY_LIST_TYPE}>;`,
    );
  });
});
