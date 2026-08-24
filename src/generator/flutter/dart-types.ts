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
import { MONEY_WIRE_SCALE } from "../money-scale.js";

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
    case "money":
      return "double";
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
      // `datetime` needs ISO-string conversion, `File` is the `FileRef`
      // object (`.toJson()` / `.fromJson`), and `money` rides the wire as a
      // decimal STRING — `MONEY_WIRE_SCALE` digits, the shape every backend
      // serves and every backend's request schema validates (`z.string()`).
      // It was in this set, so a Flutter client POSTed a bare JSON number the
      // backend rejects.
      return base.name !== "datetime" && base.name !== "File" && base.name !== "money";
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
          // `{"type":"string","format":"decimal"}`.  This used to read
          // `(x as num).toDouble()`, so EVERY money read threw
          // `String is not a subtype of num` at runtime — invisible to
          // `flutter analyze`/`build`, which cannot see a cast.
          //
          // The parse is tolerant of a bare number too (`'$x'` stringifies
          // either shape): a hand-rolled `extern` endpoint outside the
          // generated contract is then merely imprecise rather than fatal.
          return `double.parse('\${${access}}')`;
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
      // Non-identity primitives: `File` (the `FileRef` object), `datetime`,
      // and `money` — which goes back out as the same fixed-scale decimal
      // STRING the backend's request schema validates (`z.string()` +
      // `^-?\d+(\.\d+)?$`).  A bare `double` here was rejected at the wire
      // boundary on every write.
      if (base.name === "File") return `${access}.toJson()`;
      if (base.name === "money") return `${access}.toStringAsFixed(${MONEY_WIRE_SCALE})`;
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
