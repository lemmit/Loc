import type { BoundedContextIR, EnumIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { emptyPyTypeImports, visitPyTypeImports } from "../py-type-imports.js";
import { collectPyExprImports, renderPyExpr, renderPyType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `app/domain/value_objects.py` — enums as `StrEnum` subclasses (member
// name == wire value, parity with the other backends' string-coded
// enums) + value objects as plain classes with constructor-enforced
// invariants, `@property` per derived, and a public method per
// `function` (VO functions are cross-boundary surface, so no `_`
// prefix — see render-expr.ts's `fnPrefix`).
// ---------------------------------------------------------------------------

/** Render context for VO bodies: public method spelling for functions. */
const VO_CTX = { thisName: "self", fnPrefix: "" };

export function renderPyEnumsAndValueObjects(ctx: BoundedContextIR): string {
  const types = emptyPyTypeImports();
  const exprImports = new Set<string>();
  for (const v of ctx.valueObjects) {
    for (const f of v.fields) visitPyTypeImports(f.type, types);
    for (const d of v.derived) {
      visitPyTypeImports(d.type, types);
      collectPyExprImports(d.expr, exprImports);
    }
    for (const fn of v.functions) {
      visitPyTypeImports(fn.returnType, types);
      for (const p of fn.params) visitPyTypeImports(p.type, types);
      collectPyExprImports(fn.body, exprImports);
    }
    for (const inv of v.invariants) {
      collectPyExprImports(inv.expr, exprImports);
      if (inv.guard) collectPyExprImports(inv.guard, exprImports);
    }
  }
  const hasInvariants = ctx.valueObjects.some((v) => v.invariants.length > 0);
  const usesDecimal = types.usesDecimal || exprImports.has("decimal");
  const usesDatetime = types.usesDatetime || exprImports.has("datetime");
  const idNames = [...types.idNames].sort();

  return lines(
    `"""Enums + value objects with constructor-enforced invariants.  Auto-generated."""`,
    "",
    exprImports.has("re") ? "import re" : null,
    usesDatetime ? "from datetime import UTC, datetime" : null,
    usesDecimal ? "from decimal import Decimal" : null,
    ctx.enums.length > 0 ? "from enum import StrEnum" : null,
    hasInvariants ? "" : null,
    hasInvariants ? "from app.domain.errors import DomainError" : null,
    idNames.length > 0
      ? `from app.domain.ids import ${idNames.map((n) => `${n}Id`).join(", ")}`
      : null,
    ...ctx.enums.flatMap(renderPyEnum),
    ...ctx.valueObjects.flatMap(renderPyValueObject),
    "",
  );
}

function renderPyEnum(e: EnumIR): string[] {
  return ["", "", `class ${e.name}(StrEnum):`, ...e.values.map((v) => `    ${v} = "${v}"`)];
}

function renderPyValueObject(v: ValueObjectIR): string[] {
  const params = v.fields.map((f) => `${snake(f.name)}: ${renderPyType(f.type)}`);
  const assigns = v.fields.map((f) => `        self.${snake(f.name)} = ${snake(f.name)}`);
  const invariants = v.invariants.flatMap((inv) => {
    const cond = inv.guard
      ? `(${renderPyExpr(inv.guard, VO_CTX)}) and not (${renderPyExpr(inv.expr, VO_CTX)})`
      : `not (${renderPyExpr(inv.expr, VO_CTX)})`;
    return [
      `        if ${cond}:`,
      `            raise DomainError(${JSON.stringify(`Invariant violated: ${inv.source}`)})`,
    ];
  });
  const derived = v.derived.flatMap((d) => [
    "",
    "    @property",
    `    def ${snake(d.name)}(self) -> ${renderPyType(d.type)}:`,
    `        return ${renderPyExpr(d.expr, VO_CTX)}`,
  ]);
  const fns = v.functions.flatMap((fn) => {
    const fnParams = ["self", ...fn.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`)];
    return [
      "",
      `    def ${snake(fn.name)}(${fnParams.join(", ")}) -> ${renderPyType(fn.returnType)}:`,
      `        return ${renderPyExpr(fn.body, VO_CTX)}`,
    ];
  });
  return [
    "",
    "",
    `class ${v.name}:`,
    `    def __init__(self, ${params.join(", ")}) -> None:`,
    ...assigns,
    ...invariants,
    ...derived,
    ...fns,
  ];
}
