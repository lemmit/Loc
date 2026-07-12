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
