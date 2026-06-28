import type { BoundedContextIR, EnumIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsExpr, renderTsType } from "../render-expr.js";
import { renderTsStatements } from "../render-stmt.js";

// ---------------------------------------------------------------------------
// Enums + value objects emitted into one file.  Enums become
// `as const` objects + a literal-union type; value objects become
// classes with constructor-based invariant checks, getter-style
// `derived`, and private helpers per `function`.
// ---------------------------------------------------------------------------

export function renderEnumsAndValueObjects(ctx: BoundedContextIR): string {
  return (
    lines(
      "// Auto-generated.",
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
  const invariants = v.invariants.map((inv) => {
    const check = inv.guard
      ? `if ((${renderTsExpr(inv.guard)}) && !(${renderTsExpr(inv.expr)}))`
      : `if (!(${renderTsExpr(inv.expr)}))`;
    return `    ${check} throw new Error(${JSON.stringify(`Invariant violated: ${inv.source}`)});`;
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
  return [
    `export class ${v.name} {`,
    "  constructor(",
    ...ctorParams,
    "  ) {",
    ...invariants,
    "  }",
    "",
    ...derived,
    ...fns,
    "}",
    "",
  ];
}
