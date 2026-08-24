// TypeIR → Dart type spelling + JSON codec expressions for the Flutter
// frontend.  The Dart analogue of `feliz/type-fs.ts` (which renders F#) and of
// `_frontend/zod-schemas.ts` (which renders the zod wire contract) — every
// helper here is driven purely by the wire `TypeIR`, so a Dart wire model lines
// up field-for-field with what the backend actually serves.
//
// Walking-skeleton scope: scalar + collection + nested-record wire types.  The
// hand-written `fromJson`/`toJson` bodies mean the emitted models need NO
// `json_serializable` / `build_runner` codegen.  Discriminated payload unions
// (`sealed class` + Dart-3 `switch`) are deferred — see
// `// TODO(flutter full-parity):` in `dart-model-emit.ts`.

import type { PrimitiveName, TypeIR } from "../../ir/types/loom-ir.js";

/** Peel a single `optional` layer — the wire optionality is carried once, at
 *  the field level, so the codec never double-wraps. */
function peelOptional(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** Dart type spelling for a primitive wire type. */
function dartPrimitive(name: PrimitiveName): string {
  switch (name) {
    case "int":
    case "long":
      return "int";
    case "decimal":
      return "double";
    case "money":
      // MONEY IS THE WIRE STRING, NOT A NUMBER (M-T1.21).  `money` persists as
      // `NUMERIC(19,4)` and rides the wire as a fixed-scale decimal STRING
      // (`money-scale.ts`, RS-12).  A Dart `double` is a binary float with
      // ~15–17 significant digits, so it cannot hold that range exactly, and
      // every read→write round trip through one re-quantizes the value.  The
      // string IS the value here; `LoomMoney` (`money-runtime.ts`) owns the
      // arithmetic on it, exactly as `decimal.js` does on the JS frontends and
      // `System.Decimal` does on Feliz.  `decimal` (RS-24, a JSON number) is
      // unaffected and stays `double` — the deliberate contrast.
      return "String";
    case "bool":
      return "bool";
    case "datetime":
      return "DateTime";
    case "json":
      // Opaque JSON blob — interior is not modelled, so it stays `dynamic`.
      return "dynamic";
    case "File":
      // The fixed `FileRef` wire object (url/key/contentType/size), always
      // NULLABLE — a `File` holds a FileRef-or-nothing (unset until uploaded),
      // so `File` and `File?` both spell `FileRef?`.  The `FileRef` Dart class is
      // emitted into `lib/models.dart`.
      return "FileRef?";
    default:
      // string, guid → String.
      return "String";
  }
}

/** Non-nullable Dart type spelling for a wire `TypeIR`.  An `optional` inner
 *  layer appends `?`; the caller adds `?` for a wire field whose optionality is
 *  carried by the `WireField.optional` flag rather than an `optional` type. */
/** The Dart spelling of the shared `Provenanced<T>` wire carrier. */
export const DART_PROVENANCED = "Provenanced";

export function dartType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return dartPrimitive(t.name);
    case "id":
      // Ids ride the wire as plain strings (mirrors `feliz/type-fs.ts`); the
      // skeleton emits no dedicated `<Agg>Id` wrapper class.
      return "String";
    case "enum":
      // Enum values ride the wire as their string name; the skeleton keeps them
      // as `String` rather than emitting a Dart `enum`.
      return "String";
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `List<${dartType(t.element)}>`;
    case "genericInstance":
      // `Provenanced<int>` (M-T6.12) — the value + lineage wire carrier.  An
      // explicit arm, not the `dynamic` fallthrough: a dynamic here would
      // silently drop the value's type out of the model and out of every page
      // that reads it.
      if (t.ctor === "provenanced") return `${DART_PROVENANCED}<${dartType(t.arg)}>`;
      return "dynamic";
    case "optional": {
      // `File` already spells the nullable `FileRef?`, so `File?` must not
      // double-up to `FileRef??`.
      const inner = dartType(t.inner);
      return inner.endsWith("?") ? inner : `${inner}?`;
    }
    default:
      return "dynamic";
  }
}

/** Whether a value of type `t` encodes to JSON unchanged (no `.toJson()` /
 *  `.toIso8601String()` / element mapping needed) — lets `dartToJson` emit the
 *  bare field for scalars and null-guard only the transforming cases. */
export function isIdentityJson(t: TypeIR): boolean {
  const base = peelOptional(t);
  switch (base.kind) {
    case "primitive":
      // Every scalar (incl. `double`/`int`/`bool`/`dynamic`) is JSON-native;
      // `datetime` needs ISO-string conversion and `File` is the `FileRef`
      // object (`.toJson()` / `.fromJson`).  `money` is back in this set for
      // the reason it was once out of it: it rides the wire as a decimal
      // STRING, and now it IS a Dart `String` (M-T1.21) — so the value the
      // model holds is already the wire value, byte for byte, and `toJson`
      // has nothing to convert.  (While money was a `double` this had to be
      // false, because the double had to be re-formatted on the way out.)
      return base.name !== "datetime" && base.name !== "File";
    case "id":
    case "enum":
      return true;
    case "array":
      return isIdentityJson(base.element);
    default:
      // valueobject / entity → `.toJson()`.
      return false;
  }
}

/** Dart expression decoding a `dynamic` JSON value `access` into type `t`.
 *  Non-nullable base cases; optionality is layered in the model emitter. */
export function dartFromJson(t: TypeIR, access: string): string {
  const base = peelOptional(t);
  switch (base.kind) {
    case "primitive":
      switch (base.name) {
        case "int":
        case "long":
          return `${access} as int`;
        case "decimal":
          // `decimal` rides the wire as a JSON NUMBER (`z.number()` in the
          // shared frontend contract) — unchanged.
          return `(${access} as num).toDouble()`;
        case "money":
          // `money` rides the wire as a decimal STRING at MONEY_WIRE_SCALE
          // digits (`money-scale.ts`, RS-12) — every backend serves
          // `"12.5000"`, and the emitted `wire-spec.json` declares
          // `{"type":"string","format":"decimal"}`.  It is TAKEN AS-IS: no
          // parse, so nothing is lost and nothing can throw on a value wider
          // than a binary float (M-T1.21).  `'${…}'` stringifies rather than
          // casts, so a hand-rolled `extern` endpoint serving a bare JSON
          // number still decodes instead of crashing.
          return `'\${${access}}'`;
        case "bool":
          return `${access} as bool`;
        case "datetime":
          return `DateTime.parse(${access} as String)`;
        case "json":
          return access; // opaque — passed through as dynamic
        case "File":
          return `FileRef.fromJson(${access} as Map<String, dynamic>)`;
        default:
          return `${access} as String`;
      }
    case "id":
    case "enum":
      return `${access} as String`;
    case "valueobject":
    case "entity":
      return `${base.name}.fromJson(${access} as Map<String, dynamic>)`;
    case "array":
      return `(${access} as List<dynamic>).map((e) => ${dartFromJson(base.element, "e")}).toList()`;
    case "genericInstance":
      if (base.ctor === "provenanced") {
        // The carrier's `fromJson` takes a decoder for the value half, so the
        // carried type keeps its own conversion (a `datetime` value still
        // parses, a nested VO still builds its class).
        return `${DART_PROVENANCED}.fromJson(${access} as Map<String, dynamic>, (__v) => ${dartFromJson(base.arg, "__v")})`;
      }
      return access;
    default:
      return access;
  }
}

/** Dart expression encoding a field value `access` of type `t` back to JSON.
 *  Identity types return the bare value; only `datetime`, records, and arrays
 *  of those transform. */
export function dartToJson(t: TypeIR, access: string): string {
  const base = peelOptional(t);
  if (isIdentityJson(base)) return access;
  switch (base.kind) {
    case "primitive":
      // Non-identity primitives: `File` (the `FileRef` object) and `datetime`.
      // `money` is NOT here: it is a Dart `String` holding the wire's own
      // digits, so it goes back out unchanged — the shape the backend's
      // request schema validates (`z.string()` over `^-?\d+(\.\d+)?$`).
      if (base.name === "File") return `${access}.toJson()`;
      return `${access}.toIso8601String()`;
    case "valueobject":
    case "entity":
      return `${access}.toJson()`;
    case "array":
      return `${access}.map((e) => ${dartToJson(base.element, "e")}).toList()`;
    default:
      return access;
  }
}
