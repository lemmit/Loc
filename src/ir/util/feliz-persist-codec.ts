// ---------------------------------------------------------------------------
// Feliz store-persistence codecs (`persist: local|session|url`).
//
// Feliz stores fold into the single Elmish `Model`, so persistence rides the
// fold: `init` seeds each persisted field from its backing store and the
// `update` loop mirrors the Model back.  Crossing the JS boundary is per FIELD
// (a raw `string` out of `localStorage`/`sessionStorage`/the query string, then
// an F# conversion), so a field type only persists when there IS an F# codec
// for it — hence this classifier.
//
// It lives at the IR layer, not in `src/generator/feliz/`, because BOTH sides
// consult it: the emitter picks the codec, and `store-checks.ts` raises
// `loom.store-persist-field-unsupported` for the fields that have none (a
// generator import from the validator would be a backward layer edge).  Same
// home, same reason, as `feliz-async-effect.ts`.
//
// The supported set is bounded by what `type-fs.ts` spells and what the F#
// conversion path can do TOTALLY (never throwing on junk input, exactly like
// the JS frontends' decoders):
//
//   string / json / id       → F# `string`   — the raw value, verbatim
//   int / long               → F# `int`      — `System.Int32.TryParse`
//   bool                     → F# `bool`     — `= "true"`
//   decimal / money          → F# `decimal`  — `System.Decimal.TryParse`
//   arrays of the above minus decimal → F# `'T list`
//
// Everything else is gated: `datetime`/`duration`/`guid` spell .NET types with
// no total parse on this path, `enum` spells the enum's own F# name, and
// `entity`/`valueobject` (and arrays of them) would need a record codec the
// store path does not emit.
// ---------------------------------------------------------------------------

import type { TypeIR } from "../types/loom-ir.js";

/** The scalar codecs a persisted Feliz store field can use. */
export type FelizPersistScalar =
  | "string"
  /** F# `int` — `System.Int32.TryParse`, JSON number. */
  | "int"
  /** F# `bool` — `"true"`, JSON boolean. */
  | "bool"
  /** F# `decimal` serialised as a JSON NUMBER (Loom `decimal`; the JS
   *  frontends hold it in a plain `number`). */
  | "decimal"
  /** F# `decimal` serialised as a JSON STRING (Loom `money`; the JS frontends
   *  hold it in a `Decimal` whose `toJSON` is a string). */
  | "money";

/** How one persisted store field crosses the JS boundary. */
export type FelizPersistCodec =
  | { kind: "scalar"; scalar: FelizPersistScalar }
  /** An F# `'T list` over a scalar element (never `decimal`/`money` — a
   *  `Decimal[]` has no total element parse on this path). */
  | { kind: "list"; element: Exclude<FelizPersistScalar, "decimal" | "money"> };

function scalarCodec(t: TypeIR): FelizPersistScalar | undefined {
  if (t.kind === "id") return "string";
  if (t.kind !== "primitive") return undefined;
  switch (t.name) {
    case "int":
    case "long":
      return "int";
    case "bool":
      return "bool";
    case "decimal":
      return "decimal";
    case "money":
      return "money";
    case "string":
    case "json":
      return "string";
    default:
      // datetime / duration / guid — `type-fs.ts` spells these `System.*`, and
      // there is no total round-trip through a raw query param / JSON scalar.
      return undefined;
  }
}

/** The codec for a persisted Feliz store field, or `undefined` when the type
 *  has none (→ `loom.store-persist-field-unsupported`). */
export function felizPersistCodec(t: TypeIR): FelizPersistCodec | undefined {
  if (t.kind === "array") {
    const el = scalarCodec(t.element);
    if (el === undefined || el === "decimal" || el === "money") return undefined;
    return { kind: "list", element: el };
  }
  const s = scalarCodec(t);
  return s === undefined ? undefined : { kind: "scalar", scalar: s };
}
