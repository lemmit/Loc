import type { AggregateIR, BoundedContextIR, TestIR, TestStmtIR } from "../../../ir/loom-ir.js";
import { camel } from "../../../util/naming.js";
import { renderTsExpr } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → vitest test file.
//
// Each test block becomes an `it("name", () => { ... })` case.  Statements
// inside use the same renderer as operation bodies, with two extra forms:
//
//   expect <expr>           → vitest `expect(<expr>).toBe(true)`
//   expectThrows <call>     → vitest `expect(() => <call>).toThrow()`
//
// The container is a plain test file colocated next to the domain class;
// it imports the aggregate / parts / value objects directly.
// ---------------------------------------------------------------------------

export function renderTestsFile(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string | null {
  if (agg.tests.length === 0) return null;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { describe, it, expect } from "vitest";`);
  lines.push(`import { ${agg.name}${agg.parts.length > 0 ? ", " + agg.parts.map((p) => p.name).join(", ") : ""} } from "./${camel(agg.name)}.js";`);
  const voNames = ctx.valueObjects.map((v) => v.name);
  if (voNames.length > 0) {
    lines.push(`import { ${voNames.join(", ")} } from "./value-objects.js";`);
  }
  const enumNames = ctx.enums.map((e) => e.name);
  if (enumNames.length > 0) {
    lines.push(`import { ${enumNames.join(", ")} } from "./value-objects.js";`);
  }
  lines.push(`import * as Ids from "./ids.js";`);
  lines.push("");
  lines.push(`describe("${agg.name}", () => {`);
  for (const t of agg.tests) {
    lines.push(...renderTest(t).map((l) => `  ${l}`));
    lines.push("");
  }
  lines.push(`});`);
  return lines.join("\n") + "\n";
}

function renderTest(t: TestIR): string[] {
  const out: string[] = [];
  out.push(`it(${JSON.stringify(t.name)}, () => {`);
  for (const s of t.statements) {
    const rendered = renderTestStmt(s);
    if (rendered) out.push(...rendered.split("\n"));
  }
  out.push(`});`);
  return out;
}

function renderTestStmt(s: TestStmtIR): string {
  if (s.kind === "expect") {
    return `  expect(${renderTsExpr(s.expr)}).toBe(true);`;
  }
  if (s.kind === "expect-throws") {
    return `  expect(() => { ${renderTsExpr(s.expr)}; }).toThrow();`;
  }
  if (s.kind === "let") {
    return `  const ${s.name} = ${renderTsExpr(s.expr)};`;
  }
  if (s.kind === "precondition") {
    return `  expect(${renderTsExpr(s.expr)}).toBe(true);`;
  }
  if (s.kind === "emit") {
    // Emit is a no-op inside a test — events would need an aggregate.
    return ``;
  }
  if (s.kind === "assign" || s.kind === "add" || s.kind === "remove") {
    // Bare assignments aren't valid in a test — they'd need an aggregate
    // instance.  Render as a comment so the user can fix.
    return `  // TODO: '${s.kind}' inside test — wrap with an aggregate operation`;
  }
  if (s.kind === "call") {
    return `  // call: ${s.name}(...)`;
  }
  if (s.kind === "expression") {
    return `  ${renderTsExpr(s.expr)};`;
  }
  return "";
}
