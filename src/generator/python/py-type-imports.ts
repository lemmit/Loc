import type { TypeIR } from "../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Type-graph import collection for Python emitters — which names a set
// of `TypeIR`s pulls into a module (Decimal, datetime, id NewTypes,
// VO / enum classes).  The type-side companion of render-expr.ts's
// `collectPyExprImports` (which covers expression-triggered imports).
// ---------------------------------------------------------------------------

/** The `from app.db.wire import …` line for a module's `to_wire` projection,
 *  covering both shared helpers (`iso` for datetimes, `money_str` for money) —
 *  emitted only for the helpers the module body actually references. */
export function wireHelperImport(refersTo: (n: string) => boolean): string | null {
  const names = ["iso", "money_str"].filter(refersTo);
  return names.length > 0 ? `from app.db.wire import ${names.join(", ")}` : null;
}

/** The `from datetime import …` line for a body-scan `refersTo` predicate —
 *  `UTC` (a `now()` bind renders `datetime.now(UTC)`), `datetime`, and
 *  `timedelta` (A5 temporal — absolute durations) — or null when the body
 *  references none of them. */
export function dtImportLine(refersTo: (n: string) => boolean): string | null {
  const names = ["UTC", "datetime", "timedelta"].filter(refersTo);
  return names.length > 0 ? `from datetime import ${names.join(", ")}` : null;
}

export interface PyTypeImports {
  usesDecimal: boolean;
  usesDatetime: boolean;
  /** Aggregate / part target names whose `<Name>Id` NewType is used. */
  idNames: Set<string>;
  voNames: Set<string>;
  enumNames: Set<string>;
}

export function emptyPyTypeImports(): PyTypeImports {
  return {
    usesDecimal: false,
    usesDatetime: false,
    idNames: new Set(),
    voNames: new Set(),
    enumNames: new Set(),
  };
}

export function visitPyTypeImports(t: TypeIR, acc: PyTypeImports): void {
  switch (t.kind) {
    case "primitive":
      if (t.name === "money") acc.usesDecimal = true;
      if (t.name === "datetime") acc.usesDatetime = true;
      return;
    case "id":
      acc.idNames.add(t.targetName);
      return;
    case "valueobject":
      acc.voNames.add(t.name);
      return;
    case "enum":
      acc.enumNames.add(t.name);
      return;
    case "array":
      visitPyTypeImports(t.element, acc);
      return;
    case "optional":
      visitPyTypeImports(t.inner, acc);
      return;
    case "genericInstance":
      visitPyTypeImports(t.arg, acc);
      return;
    case "union":
      for (const v of t.variants) visitPyTypeImports(v, acc);
      return;
    default:
      // entity | slot | none — nothing importable at this layer.
      return;
  }
}
