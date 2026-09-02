import type { EnumIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import {
  collectCsExprUsings,
  collectCsTypeUsings,
  renderCsExpr,
  renderCsType,
} from "../render-expr.js";
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
    collectCsExprUsings(inv.expr, usings, ns);
    if (inv.guard) collectCsExprUsings(inv.guard, usings, ns);
  }
  for (const d of vo.derived) collectCsExprUsings(d.expr, usings, ns);
  for (const fn of vo.functions) {
    if ("expr" in fn.body) collectCsExprUsings(fn.body.expr, usings, ns);
    else collectCsStmtUsings(fn.body.stmts, usings, ns);
  }
  // …and the namespaces its rendered TYPES name.  The expression collectors
  // above see only what a BODY reaches into, but every position below renders
  // a `TypeIR` too — the property declarations, the constructor parameter
  // list, the derived-property types and each function's params/return.  An
  // enum-typed field (`country: Country`) renders a bare `Country` in three of
  // them and lives in `<ns>.Domain.Enums`, a namespace no expression here
  // mentions: without this the file does not compile (CS0246), which is
  // exactly what the ERP example's `Address` / `Quantity` hit.  Collected
  // rather than added unconditionally so a VO with no enum/id field keeps a
  // using-clean header under `/warnaserror` (CS8019).
  for (const f of vo.fields) collectCsTypeUsings(f.type, usings, ns);
  for (const d of vo.derived) collectCsTypeUsings(d.type, usings, ns);
  for (const fn of vo.functions) {
    collectCsTypeUsings(fn.returnType, usings, ns);
    for (const p of fn.params) collectCsTypeUsings(p.type, usings, ns);
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
