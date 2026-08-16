// TypeIR → F# type spelling for the Feliz frontend.  Covers the arm set a
// page `state {}` field / action payload param reaches today; grown as
// examples exercise more.

import type { PrimitiveName, TypeIR } from "../../ir/types/loom-ir.js";

function fsPrimitive(name: PrimitiveName): string {
  switch (name) {
    case "int":
    case "long":
      return "int";
    case "decimal":
    case "money":
      return "decimal";
    case "bool":
      return "bool";
    case "datetime":
      return "System.DateTime";
    case "duration":
      // The .NET duration type — the SAME type `FS_LEAVES.duration` constructs
      // (`System.TimeSpan.FromMilliseconds …`) and the temporal binary arms
      // consume (`DateTime.Add(TimeSpan)`).  Without this arm the fallthrough
      // spelled `string`, so a duration-typed binding declared `string` while
      // its initializer produced a `TimeSpan` — a Fable type error.
      //
      // WIRE-SIDE SCOPE: this is the STATE/expression spelling only.  A wire
      // field can never be duration-typed — `duration` is expression-only and
      // has no spelling in the grammar's `PrimitiveType` rule (`ddd.langium`),
      // so no declared property, `derived <name>: <TypeRef>`, or action param
      // can be one, and `wireShape` is built from declared types alone.  The
      // wire path (`wire.ts`'s `wireFieldType` / `decoderExprFor`) therefore
      // rejects a duration outright rather than silently pairing this
      // `System.TimeSpan` with the `Decode.string` fallthrough — the exact
      // mismatch that reverted the earlier attempt at this arm.  The node
      // backend states the same fact for its column mapper
      // (`typescript/emit/schema.ts`: "expression-only and never reaches a
      // column").
      return "System.TimeSpan";
    case "guid":
      return "System.Guid";
    default:
      return "string"; // string, guid-as-string, json, etc.
  }
}

/** F# type expression for a Loom `TypeIR`. */
export function typeToFs(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return fsPrimitive(t.name);
    case "id":
      return "string";
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `${typeToFs(t.element)} list`;
    case "optional":
      return `${typeToFs(t.inner)} option`;
    default:
      return "obj";
  }
}

/** F# zero value for a `state {}` field whose declaration omits `= <init>`. */
export function fsZeroValue(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "0";
        case "decimal":
        case "money":
          return "0m";
        case "bool":
          return "false";
        case "duration":
          // Pairs with `typeToFs`'s `System.TimeSpan` — the fallthrough `""`
          // would not typecheck against it.
          return "System.TimeSpan.Zero";
        default:
          return '""';
      }
    case "array":
      return "[]";
    case "optional":
      return "None";
    default:
      return '""';
  }
}
