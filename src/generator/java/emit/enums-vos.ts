// Enum → Java enum (constants keep the DSL casing — the wire serialises
// `name()`, so casing IS the cross-backend wire contract).  Value object
// → record with a compact constructor running the invariants (compact-
// constructor parameters carry the values; `this` is not yet available
// there, hence `bareProps`).

import type { EnumIR, ValueObjectIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import {
  collectJavaExprImports,
  collectJavaTypeImports,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";

export function renderJavaEnum(e: EnumIR, basePkg: string): string {
  const valueLines = e.values.map((v, i) => `    ${v}${i < e.values.length - 1 ? "," : ""}`);
  return lines(
    `package ${basePkg}.domain.enums;`,
    ``,
    `public enum ${e.name} {`,
    ...valueLines,
    `}`,
    ``,
  );
}

export function renderJavaValueObject(vo: ValueObjectIR, basePkg: string): string {
  const javaImports = new Set<string>();
  for (const f of vo.fields) collectJavaTypeImports(f.type, javaImports);
  for (const inv of vo.invariants) {
    collectJavaExprImports(inv.expr, javaImports);
    if (inv.guard) collectJavaExprImports(inv.guard, javaImports);
  }
  for (const d of vo.derived) {
    collectJavaExprImports(d.expr, javaImports);
    collectJavaTypeImports(d.type, javaImports);
  }
  for (const fn of vo.functions) {
    collectJavaExprImports(fn.body, javaImports);
    collectJavaTypeImports(fn.returnType, javaImports);
    for (const p of fn.params) collectJavaTypeImports(p.type, javaImports);
  }

  // Compact-constructor scope: parameters by bare name.
  const ctorCtx = { thisName: "this", bareProps: true };
  // Method scope (derived / functions): accessors + fields are available.
  const methodCtx = { thisName: "this" };

  const params = vo.fields.map((f) => `${renderJavaType(f.type)} ${f.name}`).join(", ");
  const invariantLines = vo.invariants.map((inv) => {
    const check = inv.guard
      ? `if ((${renderJavaExpr(inv.guard, ctorCtx)}) && !(${renderJavaExpr(inv.expr, ctorCtx)}))`
      : `if (!(${renderJavaExpr(inv.expr, ctorCtx)}))`;
    return `        ${check} throw new DomainException(${JSON.stringify(`Invariant violated: ${inv.source}`)});`;
  });
  const derivedLines = vo.derived.flatMap((d) => [
    `    public ${renderJavaType(d.type)} ${d.name}() {`,
    `        return ${renderJavaExpr(d.expr, methodCtx)};`,
    `    }`,
    ``,
  ]);
  const fnLines = vo.functions.flatMap((fn) => {
    const fnParams = fn.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
    return [
      `    private ${renderJavaType(fn.returnType)} ${fn.name}(${fnParams}) {`,
      `        return ${renderJavaExpr(fn.body, methodCtx)};`,
      `    }`,
      ``,
    ];
  });

  const body = [...derivedLines, ...fnLines];
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  return lines(
    `package ${basePkg}.domain.valueobjects;`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    javaImports.size > 0 ? `` : null,
    `import jakarta.persistence.Embeddable;`,
    `import org.jmolecules.ddd.annotation.ValueObject;`,
    ``,
    `import ${basePkg}.domain.common.DomainException;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    ``,
    // @Embeddable: Hibernate 6.2+ maps records as embedded components,
    // running the compact constructor (and so the invariants) on
    // hydration — same behaviour as the .NET explicit-ctor records.
    `@Embeddable`,
    `@ValueObject`,
    `public record ${vo.name}(${params}) {`,
    vo.invariants.length > 0 ? `    public ${vo.name} {` : null,
    vo.invariants.length > 0 ? invariantLines : null,
    vo.invariants.length > 0 ? `    }` : null,
    body.length > 0 && vo.invariants.length > 0 ? `` : null,
    ...body,
    `}`,
    ``,
  );
}
