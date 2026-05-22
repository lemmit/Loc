import type { EnumIR, ValueObjectIR } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { renderCsExpr, renderCsType } from "../render-expr.js";

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
  const propLines = vo.fields.map(
    (f) => `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; init; }`,
  );
  const ctorParams = vo.fields.map((f) => `${renderCsType(f.type)} ${f.name}`).join(", ");
  const ctorAssignments = vo.fields.map((f) => `        ${upperFirst(f.name)} = ${f.name};`);
  const invariantLines = vo.invariants.map((inv) => {
    const check = inv.guard
      ? `if ((${renderCsExpr(inv.guard)}) && !(${renderCsExpr(inv.expr)}))`
      : `if (!(${renderCsExpr(inv.expr)}))`;
    return `        ${check} throw new DomainException(${JSON.stringify(`Invariant violated: ${inv.source}`)});`;
  });
  const efCtorAssignments = vo.fields.map((f) => `        ${upperFirst(f.name)} = default!;`);
  const derivedLines = vo.derived.map(
    (d) => `    public ${renderCsType(d.type)} ${upperFirst(d.name)} => ${renderCsExpr(d.expr)};`,
  );
  const fnLines = vo.functions.map((fn) => {
    const params = fn.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    return `    private ${renderCsType(fn.returnType)} ${upperFirst(fn.name)}(${params}) => ${renderCsExpr(fn.body)};`;
  });

  return (
    lines(
      "// Auto-generated.",
      "using System;",
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
