import {
  type BoundedContextIR,
  type EnumIR,
  type TypeIR,
  typeUsesMoney,
  type ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsExpr, renderTsType } from "../render-expr.js";
import { renderTsStatements } from "../render-stmt.js";

// ---------------------------------------------------------------------------
// Enums + value objects emitted into one file.  Enums become
// `as const` objects + a literal-union type; value objects become
// classes with constructor-based invariant checks, VALUE equality
// (`equals()` — S9: a VO's defining property; reference identity is
// the entity semantics), getter-style `derived`, and public methods
// per `function`.
// ---------------------------------------------------------------------------

export function renderEnumsAndValueObjects(ctx: BoundedContextIR): string {
  const needsDomainError = ctx.valueObjects.some((v) => v.invariants.length > 0);
  // A `money` VO field renders as decimal.js `Decimal` (renderTsType), so the
  // class needs the import — previously missing (latent tsc break on any VO
  // carrying money).
  const usesMoney = ctx.valueObjects.some((v) => v.fields.some((f) => typeUsesMoney(f.type)));
  return (
    lines(
      "// Auto-generated.",
      usesMoney ? 'import Decimal from "decimal.js";' : null,
      needsDomainError ? 'import { DomainError } from "./errors";' : null,
      "",
      ...ctx.enums.flatMap(renderEnum),
      ...ctx.valueObjects.flatMap(renderValueObject),
    ) + "\n"
  );
}

function renderEnum(e: EnumIR): string[] {
  const valueLines = e.values.map((v, i) => `  ${v}: "${v}"${i < e.values.length - 1 ? "," : ""}`);
  const unionLiteral = e.values.map((v) => `"${v}"`).join(" | ");
  return [
    `export const ${e.name} = {`,
    ...valueLines,
    "} as const;",
    `export type ${e.name} = ${unionLiteral};`,
    "",
  ];
}

function renderValueObject(v: ValueObjectIR): string[] {
  const ctorParams = v.fields.map(
    (f, i) =>
      `    public readonly ${f.name}: ${renderTsType(f.type)}${i < v.fields.length - 1 ? "," : ""}`,
  );
  // Invariant violations throw DomainError, not a bare Error (S9): a VO
  // tripping on request input must surface through the ProblemDetails
  // taxonomy (400), never as an unclassified 500.
  const invariants = v.invariants.map((inv) => {
    const check = inv.guard
      ? `if ((${renderTsExpr(inv.guard)}) && !(${renderTsExpr(inv.expr)}))`
      : `if (!(${renderTsExpr(inv.expr)}))`;
    return `    ${check} throw new DomainError(${JSON.stringify(`Invariant violated: ${inv.source}`)});`;
  });
  const derived = v.derived.map(
    (d) => `  get ${d.name}(): ${renderTsType(d.type)} { return ${renderTsExpr(d.expr)}; }`,
  );
  const fns = v.functions.flatMap((fn) => {
    const params = fn.params.map((p) => `${p.name}: ${renderTsType(p.type)}`).join(", ");
    // Value-object functions are part of the VO's public surface — they're
    // invoked across aggregate boundaries (e.g. `probability.asFraction()`
    // from an aggregate's derived field), so they cannot be `private`.
    const head = `  ${lowerFirst(fn.name)}(${params}): ${renderTsType(fn.returnType)}`;
    if ("expr" in fn.body) {
      return [`${head} { return ${renderTsExpr(fn.body.expr)}; }`];
    }
    return [`${head} {`, renderTsStatements(fn.body.stmts), `  }`];
  });
  // Value equality — field-wise, type-driven (nested VOs recurse through
  // their own `equals`, Decimal/Date compare by value, arrays element-wise).
  const fieldEqs = v.fields.map((f) => fieldEquals(`this.${f.name}`, `other.${f.name}`, f.type));
  const equalsBody = fieldEqs.length > 0 ? `return ${fieldEqs.join(" && ")};` : "return true;";
  return [
    `export class ${v.name} {`,
    "  constructor(",
    ...ctorParams,
    "  ) {",
    ...invariants,
    "  }",
    "",
    `  equals(other: ${v.name}): boolean {`,
    `    ${equalsBody}`,
    "  }",
    "",
    ...derived,
    ...fns,
    "}",
    "",
  ];
}

/** A boolean expression comparing one VO field by VALUE.  Type-driven:
 *  `===` for primitives / branded ids / enum literals; `.equals(...)` for
 *  nested VOs and `money` (decimal.js `Decimal`); `getTime()` for `Date`;
 *  element-wise recursion for arrays; null-guarded recursion for optionals;
 *  structural JSON comparison for the open-shape `json` primitive. */
function fieldEquals(a: string, b: string, t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      if (t.name === "money") return `${a}.equals(${b})`;
      if (t.name === "datetime") return `${a}.getTime() === ${b}.getTime()`;
      if (t.name === "json") return `JSON.stringify(${a}) === JSON.stringify(${b})`;
      return `${a} === ${b}`;
    case "valueobject":
    case "entity":
      return `${a}.equals(${b})`;
    case "array":
      return `(${a}.length === ${b}.length && ${a}.every((__e, __i) => ${fieldEquals(
        "__e",
        `${b}[__i]!`,
        t.element,
      )}))`;
    case "optional":
      return `(${a} === null || ${b} === null ? ${a} === ${b} : ${fieldEquals(a, b, t.inner)})`;
    default:
      return `${a} === ${b}`;
  }
}
