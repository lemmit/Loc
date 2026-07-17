import type { EnumIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { collectCsExprUsings, renderCsExpr, renderCsType } from "../render-expr.js";
import { collectCsStmtUsings, renderCsStatements } from "../render-stmt.js";

// Enum → C# enum.  Value object → sealed record with explicit
// constructors (so invariants always run; positional records would
// skip the invariant block).

export function renderEnum(e: EnumIR, ns: string): string {
  const valueLines = e.values.map((v, i) => `    ${v}${i < e.values.length - 1 ? "," : ""}`);
  return (
    lines(
      "// Auto-generated.",
      `namespace ${ns}.Domain.Enums;`,
      "",
      `public enum ${e.name}`,
      "{",
      ...valueLines,
      "}",
    ) + "\n"
  );
}

export function renderValueObject(vo: ValueObjectIR, ns: string): string {
  // Non-implicit namespaces this value object's rendered expressions
  // reach into (e.g. System.Text.RegularExpressions for an invariant
  // using `value.matches(...)`), collected over the same invariant /
  // derived / function bodies rendered below.
  const usings = new Set<string>();
  for (const inv of vo.invariants) {
    collectCsExprUsings(inv.expr, usings);
    if (inv.guard) collectCsExprUsings(inv.guard, usings);
  }
  for (const d of vo.derived) collectCsExprUsings(d.expr, usings);
  for (const fn of vo.functions) {
    if ("expr" in fn.body) collectCsExprUsings(fn.body.expr, usings);
    else collectCsStmtUsings(fn.body.stmts, usings);
  }
  const renderCtx = { thisName: "this" };
  const propLines = vo.fields.map(
    (f) => `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; init; }`,
  );
  const ctorParams = vo.fields.map((f) => `${renderCsType(f.type)} ${f.name}`).join(", ");
  const ctorAssignments = vo.fields.map((f) => `        ${upperFirst(f.name)} = ${f.name};`);
  const invariantLines = vo.invariants.map((inv) => {
    const check = inv.guard
      ? `if ((${renderCsExpr(inv.guard, renderCtx)}) && !(${renderCsExpr(inv.expr, renderCtx)}))`
      : `if (!(${renderCsExpr(inv.expr, renderCtx)}))`;
    return `        ${check} throw new DomainException(${JSON.stringify(inv.message ? inv.message.text : `Invariant violated: ${inv.source}`)});`;
  });
  const efCtorAssignments = vo.fields.map((f) => `        ${upperFirst(f.name)} = default!;`);
  const derivedLines = vo.derived.map(
    (d) =>
      `    public ${renderCsType(d.type)} ${upperFirst(d.name)} => ${renderCsExpr(d.expr, renderCtx)};`,
  );
  const fnLines = vo.functions.flatMap((fn) => {
    const params = fn.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    const head = `    private ${renderCsType(fn.returnType)} ${upperFirst(fn.name)}(${params})`;
    if ("expr" in fn.body) {
      return [`${head} => ${renderCsExpr(fn.body.expr, renderCtx)};`];
    }
    const body = renderCsStatements(fn.body.stmts, renderCtx);
    return [head, "    {", ...(body.length > 0 ? [body] : []), "    }"];
  });

  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      ...extraUsings,
      `using ${ns}.Domain.Common;`,
      "",
      `namespace ${ns}.Domain.ValueObjects;`,
      "",
      `public sealed record ${vo.name}`,
      "{",
      ...propLines,
      `    public ${vo.name}(${ctorParams})`,
      "    {",
      ...ctorAssignments,
      ...invariantLines,
      "    }",
      "",
      "    /// <summary>Parameterless constructor reserved for EF Core / serializers.</summary>",
      `    private ${vo.name}()`,
      "    {",
      ...efCtorAssignments,
      "    }",
      "",
      ...derivedLines,
      ...fnLines,
      "}",
    ) + "\n"
  );
}
