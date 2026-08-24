// ---------------------------------------------------------------------------
// Flutter store-persistence codecs (`persist: local|session|url`).
//
// A Flutter store is a Riverpod `Notifier<<Store>State>` over an immutable Dart
// data class, so persistence rides that class: `build()` seeds each persisted
// cell from its backing store and a `ref.listenSelf` mirror writes the whole
// state back after every transition.  Both directions cross an UNTYPED boundary
// per FIELD — a `dynamic` out of a decoded JSON blob, or a raw `String` out of
// the query string — so a field type only persists when there is a TOTAL Dart
// conversion for it (one that never throws on junk input, exactly like the JS
// frontends' decoders).  Hence this classifier.
//
// It lives at the IR layer, not in `src/generator/flutter/`, because BOTH sides
// consult it: the emitter picks the codec, and `store-checks.ts` raises
// `loom.store-lifetime-target-unsupported` (its `#flutter-field` variant) for
// the fields that have none — a generator import from the validator would be a
// backward layer edge.  Same home, same reason, as `feliz-persist-codec.ts`.
//
// The supported set mirrors what `generator/flutter/dart-types.ts` spells:
//
//   string / guid / id / enum       → Dart `String`   — the raw value
//   int / long                      → Dart `int`      — `int.tryParse`
//   decimal                         → Dart `double`   — JSON number
//   money                           → Dart `String`   — the wire's own digits,
//                                     a JSON *string* both ways (M-T1.21; the
//                                     JS frontends hold a `Decimal`, whose
//                                     `toJSON` is that same string)
//   bool                            → Dart `bool`
//   datetime                        → Dart `DateTime` — ISO-8601 string, read
//                                     via `DateTime.tryParse`
//   arrays of any of the above      → `List<T>`
//
// Everything else is gated.  `json` spells `dynamic` (no typed cell to restore
// into), `File` spells the `FileRef?` object, `valueobject`/`entity` would need
// a per-record codec the store path does not emit, and an `optional` cell has no
// "absent vs. null" distinction in a flat blob / query param.
// ---------------------------------------------------------------------------

import type { TypeIR } from "../types/loom-ir.js";

/** The scalar codecs a persisted Flutter store field can use. */
export type FlutterPersistScalar =
  /** Dart `String` — the raw value, verbatim. */
  | "string"
  /** Dart `int` — JSON number; `int.tryParse` out of a query param. */
  | "int"
  /** Dart `double` from a JSON NUMBER (Loom `decimal`; the JS frontends hold it
   *  in a plain `number`). */
  | "double"
  /** Dart `String` from a JSON STRING (Loom `money` — the wire's fixed-scale
   *  decimal, held verbatim; the JS frontends hold it in a `Decimal`, whose
   *  `toJSON` is that same string). */
  | "money"
  /** Dart `bool`. */
  | "bool"
  /** Dart `DateTime` — an ISO-8601 string both ways. */
  | "datetime";

/** How one persisted store field crosses the untyped boundary. */
export type FlutterPersistCodec =
  | { kind: "scalar"; scalar: FlutterPersistScalar }
  | { kind: "list"; element: FlutterPersistScalar };

function scalarCodec(t: TypeIR): FlutterPersistScalar | undefined {
  // Ids and enums ride the wire (and Dart) as plain strings — `dart-types.ts`.
  if (t.kind === "id" || t.kind === "enum") return "string";
  if (t.kind !== "primitive") return undefined;
  switch (t.name) {
    case "int":
    case "long":
      return "int";
    case "decimal":
      return "double";
    case "money":
      return "money";
    case "bool":
      return "bool";
    case "datetime":
      return "datetime";
    case "json":
    case "File":
      // `dynamic` / the `FileRef?` object — neither has a typed cell to restore
      // into from a flat blob.
      return undefined;
    default:
      // string / guid — both spell Dart `String`.  (`duration` is
      // expression-only and can never reach a field position.)
      return "string";
  }
}

/** The codec for a persisted Flutter store field, or `undefined` when the type
 *  has none (→ `loom.store-lifetime-target-unsupported#flutter-field`). */
export function flutterPersistCodec(t: TypeIR): FlutterPersistCodec | undefined {
  if (t.kind === "array") {
    const el = scalarCodec(t.element);
    return el === undefined ? undefined : { kind: "list", element: el };
  }
  const s = scalarCodec(t);
  return s === undefined ? undefined : { kind: "scalar", scalar: s };
}
