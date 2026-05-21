import type { ExprIR } from "../ir/loom-ir.js";

// Shared lowering for `expect <expr>` statements in the generated e2e
// (api) and UI specs.  A bare `expect(<comparison>).toBe(true)` collapses
// the operands to a boolean before the matcher runs, so a failure reads
// the useless "expected false to be true".  When the asserted expression
// is a top-level comparison we lower it to an operand-revealing matcher
// (`expect(actual).toBe(expected)`, `.toBeGreaterThan(…)`, …) so the
// failure message names the actual and expected values.  These matchers
// exist in both vitest and @playwright/test, so the generated docker-e2e
// specs stay valid.

/** Render one `expect <expr>` to an assertion statement (no trailing
 *  newline).  `render` lowers a sub-expression to target source. */
export function renderExpectStmt(
  expr: ExprIR,
  render: (e: ExprIR) => string,
): string {
  // Unwrap a single layer of parens so `expect (a == b)` is recognised.
  const e = expr.kind === "paren" ? expr.inner : expr;
  if (e.kind === "binary") {
    const lhs = render(e.left);
    const rhs = render(e.right);
    switch (e.op) {
      case "==":
        return `expect(${lhs}).toBe(${rhs});`;
      case "!=":
        return `expect(${lhs}).not.toBe(${rhs});`;
      case ">":
        return `expect(${lhs}).toBeGreaterThan(${rhs});`;
      case ">=":
        return `expect(${lhs}).toBeGreaterThanOrEqual(${rhs});`;
      case "<":
        return `expect(${lhs}).toBeLessThan(${rhs});`;
      case "<=":
        return `expect(${lhs}).toBeLessThanOrEqual(${rhs});`;
    }
  }
  return `expect(${render(expr)}).toBe(true);`;
}
