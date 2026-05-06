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
  // The IR validator (`validateAggregateTestBodies` in
  // src/ir/validate.ts) rejects mutating statements (`assign` /
  // `add` / `remove` / `emit` / `precondition`) and `call` to a
  // private operation — those need an aggregate instance which a
  // bare test block doesn't have.  By the time we reach the
  // generator, only `expect` / `expect-throws` / `let` / `expression`
  // and `call` to a pure function survive.
  if (s.kind === "expect") {
    return `  expect(${renderTsExpr(s.expr)}).toBe(true);`;
  }
  if (s.kind === "expect-throws") {
    return `  expect(() => { ${renderTsExpr(s.expr)}; }).toThrow();`;
  }
  if (s.kind === "let") {
    return `  const ${s.name} = ${renderTsExpr(s.expr)};`;
  }
  if (s.kind === "call") {
    // Only pure-function calls reach here (validator-rejected
    // private-operation calls).  Render as a real expression-stmt
    // call so the function fires.
    const args = s.args.map((a) => renderTsExpr(a)).join(", ");
    return `  ${s.name}(${args});`;
  }
  if (s.kind === "expression") {
    return `  ${renderTsExpr(s.expr)};`;
  }
  // Other StmtIR kinds (assign / add / remove / emit / precondition)
  // are guaranteed by the validator never to land here.  If they do,
  // it's an internal bug — fail loudly so the issue surfaces in CI.
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}
