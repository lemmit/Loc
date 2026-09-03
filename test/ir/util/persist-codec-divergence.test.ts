import { describe, expect, it } from "vitest";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { felizPersistCodec } from "../../../src/ir/util/feliz-persist-codec.js";
import { flutterPersistCodec } from "../../../src/ir/util/flutter-persist-codec.js";

// The two store-persistence classifiers — `persist: local|session|url` — and
// the DIVERGENCES between them.  M-T9.17 slice 4: no test calls either
// function today.
//
// Each answers the same question for its own target ("can a field of this type
// cross the untyped storage boundary and come back?") and each is consulted by
// BOTH halves of its pipeline: the emitter picks the codec, and a validator
// leaf raises the unsupported diagnostic for the types that have none
// (`loom.store-persist-field-unsupported` /
// `loom.store-lifetime-target-unsupported#flutter-field`).  So a wrong answer
// is either a field that silently stops persisting, or a refused model.
//
// They are written as near-twins, and that is the risk this file is shaped
// around: the two tables genuinely DISAGREE on five types, each disagreement
// for a documented reason, and a copy-paste from one file to the other would
// erase one without failing anything else.  The divergence table below is the
// point of the file; the per-type cases exist so a divergence that moves says
// WHICH side moved.

const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });
const id = (): TypeIR => ({ kind: "id", targetName: "Order", valueType: "guid" }) as TypeIR;
const enumT = (): TypeIR => ({ kind: "enum", name: "Status" });
const vo = (): TypeIR => ({ kind: "valueobject", name: "Money" });
const entity = (): TypeIR => ({ kind: "entity", name: "Line" });

describe("felizPersistCodec — the F# side", () => {
  it("keeps int and long as SEPARATE scalars", () => {
    // They were one `int` codec until M-T1.22.  `type-fs.ts` spells a Loom
    // `long` `int64`, so the `int` codec's `System.Int32.TryParse` silently
    // refuses (and drops) any persisted value past 2^31 - the store path is
    // total, so a failed parse reads as "absent", not as an error.  The `long`
    // codec parses with `System.Int64.TryParse` instead.
    expect(felizPersistCodec(prim("int"))).toEqual({ kind: "scalar", scalar: "int" });
    expect(felizPersistCodec(prim("long"))).toEqual({ kind: "scalar", scalar: "long" });
  });

  it("maps string and json to the verbatim `string` codec", () => {
    // `json` persists as the raw text — the store path never parses it.
    expect(felizPersistCodec(prim("string"))).toEqual({ kind: "scalar", scalar: "string" });
    expect(felizPersistCodec(prim("json"))).toEqual({ kind: "scalar", scalar: "string" });
  });

  it("keeps decimal and money as SEPARATE scalars", () => {
    // They differ at the wire, not in F#: `decimal` serialises as a JSON
    // number, `money` as a JSON string.  Collapsing them would round-trip one
    // of the two through the wrong JSON shape.
    expect(felizPersistCodec(prim("decimal"))).toEqual({ kind: "scalar", scalar: "decimal" });
    expect(felizPersistCodec(prim("money"))).toEqual({ kind: "scalar", scalar: "money" });
  });

  it("maps bool, and an id to `string`", () => {
    expect(felizPersistCodec(prim("bool"))).toEqual({ kind: "scalar", scalar: "bool" });
    expect(felizPersistCodec(id())).toEqual({ kind: "scalar", scalar: "string" });
  });

  it("REFUSES datetime, duration and guid — no total parse on this path", () => {
    for (const n of ["datetime", "duration", "guid"]) {
      expect(felizPersistCodec(prim(n)), n).toBeUndefined();
    }
  });

  it("REFUSES enum, value objects and entities", () => {
    expect(felizPersistCodec(enumT())).toBeUndefined();
    expect(felizPersistCodec(vo())).toBeUndefined();
    expect(felizPersistCodec(entity())).toBeUndefined();
  });

  it("lists a scalar element", () => {
    expect(felizPersistCodec(arr(prim("int")))).toEqual({ kind: "list", element: "int" });
    expect(felizPersistCodec(arr(prim("string")))).toEqual({ kind: "list", element: "string" });
    expect(felizPersistCodec(arr(id()))).toEqual({ kind: "list", element: "string" });
  });

  it("REFUSES a list of decimal or money, though both persist as scalars", () => {
    // The one asymmetry inside the F# table: the element parse has to be
    // total, and `Decimal[]` has none on this path.  Asserted against the
    // scalar case above — a table that dropped this guard would still pass any
    // test that only ever checked the scalars.
    expect(felizPersistCodec(arr(prim("decimal")))).toBeUndefined();
    expect(felizPersistCodec(arr(prim("money")))).toBeUndefined();
  });

  it("REFUSES a list whose element has no codec, and a nested list", () => {
    expect(felizPersistCodec(arr(prim("datetime")))).toBeUndefined();
    expect(felizPersistCodec(arr(vo()))).toBeUndefined();
    expect(felizPersistCodec(arr(arr(prim("int"))))).toBeUndefined();
  });
});

describe("flutterPersistCodec — the Dart side", () => {
  it("maps int and long to `int`, decimal to `double`, money to `money`", () => {
    expect(flutterPersistCodec(prim("int"))).toEqual({ kind: "scalar", scalar: "int" });
    expect(flutterPersistCodec(prim("long"))).toEqual({ kind: "scalar", scalar: "int" });
    expect(flutterPersistCodec(prim("decimal"))).toEqual({ kind: "scalar", scalar: "double" });
    expect(flutterPersistCodec(prim("money"))).toEqual({ kind: "scalar", scalar: "money" });
  });

  it("maps bool and datetime", () => {
    expect(flutterPersistCodec(prim("bool"))).toEqual({ kind: "scalar", scalar: "bool" });
    expect(flutterPersistCodec(prim("datetime"))).toEqual({ kind: "scalar", scalar: "datetime" });
  });

  it("maps id and ENUM to `string` — both ride Dart as plain strings", () => {
    expect(flutterPersistCodec(id())).toEqual({ kind: "scalar", scalar: "string" });
    expect(flutterPersistCodec(enumT())).toEqual({ kind: "scalar", scalar: "string" });
  });

  it("falls THROUGH to `string` for string and guid", () => {
    // The Dart table's default arm, not an explicit case — so a new primitive
    // added upstream silently becomes a `String` here.  Pinned so that the
    // fall-through is a decision on record rather than an accident.
    expect(flutterPersistCodec(prim("string"))).toEqual({ kind: "scalar", scalar: "string" });
    expect(flutterPersistCodec(prim("guid"))).toEqual({ kind: "scalar", scalar: "string" });
  });

  it("REFUSES json and File — neither has a typed cell to restore into", () => {
    expect(flutterPersistCodec(prim("json"))).toBeUndefined();
    expect(flutterPersistCodec(prim("File"))).toBeUndefined();
  });

  it("REFUSES value objects and entities", () => {
    expect(flutterPersistCodec(vo())).toBeUndefined();
    expect(flutterPersistCodec(entity())).toBeUndefined();
  });

  it("lists ANY scalar element it supports, decimal and money included", () => {
    expect(flutterPersistCodec(arr(prim("int")))).toEqual({ kind: "list", element: "int" });
    expect(flutterPersistCodec(arr(prim("decimal")))).toEqual({ kind: "list", element: "double" });
    expect(flutterPersistCodec(arr(prim("money")))).toEqual({ kind: "list", element: "money" });
    expect(flutterPersistCodec(arr(enumT()))).toEqual({ kind: "list", element: "string" });
  });

  it("REFUSES a list whose element has no codec, and a nested list", () => {
    expect(flutterPersistCodec(arr(prim("json")))).toBeUndefined();
    expect(flutterPersistCodec(arr(vo()))).toBeUndefined();
    expect(flutterPersistCodec(arr(arr(prim("int"))))).toBeUndefined();
  });
});

describe("the five DOCUMENTED divergences between the two tables", () => {
  // The reason this file pairs them.  Each row is a type the two targets
  // deliberately answer differently about; a copy-paste between the two
  // near-identical modules would quietly erase one, and nothing else in the
  // suite would notice.  `supported` is asserted as a boolean pair so the
  // failure message names the direction that moved.
  const support = (t: TypeIR) => ({
    feliz: felizPersistCodec(t) !== undefined,
    flutter: flutterPersistCodec(t) !== undefined,
  });

  it("enum: Dart persists it as a string, F# does NOT (it spells the enum type)", () => {
    expect(support(enumT())).toEqual({ feliz: false, flutter: true });
  });

  it("datetime: Dart has a codec, F# has no total parse", () => {
    expect(support(prim("datetime"))).toEqual({ feliz: false, flutter: true });
  });

  it("guid: Dart spells it `String`, F# spells it `System.Guid`", () => {
    expect(support(prim("guid"))).toEqual({ feliz: false, flutter: true });
  });

  it("json: F# keeps the raw text, Dart refuses (`dynamic` has no typed cell)", () => {
    // The one divergence pointing the OTHER way — so a reader cannot conclude
    // "Flutter is simply the more permissive table" and collapse the two.
    expect(support(prim("json"))).toEqual({ feliz: true, flutter: false });
  });

  it("decimal[] / money[]: Dart lists them, F# refuses (no total element parse)", () => {
    expect(support(arr(prim("decimal")))).toEqual({ feliz: false, flutter: true });
    expect(support(arr(prim("money")))).toEqual({ feliz: false, flutter: true });
  });

  it("and they AGREE on the common core, so the divergences above are the whole set", () => {
    // Without this, the table above would be consistent with the two functions
    // having drifted everywhere; pinning the agreement is what makes the five
    // rows the exhaustive difference over the types tested here.
    for (const t of [
      prim("int"),
      prim("long"),
      prim("bool"),
      prim("string"),
      prim("decimal"),
      prim("money"),
      id(),
      arr(prim("int")),
      arr(prim("string")),
    ]) {
      expect(support(t), JSON.stringify(t)).toEqual({ feliz: true, flutter: true });
    }
    for (const t of [vo(), entity(), arr(vo()), arr(arr(prim("int")))]) {
      expect(support(t), JSON.stringify(t)).toEqual({ feliz: false, flutter: false });
    }
  });
});
