import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/loom-ir.js";
import { intrinsicMatcherSig } from "../../../language/type-system.js";
import { upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → xUnit test class.
//
// Each test block becomes a `[Fact]`-decorated method.  Statements use the
// same renderer as operation bodies, with two extra forms:
//
//   expect <expr>          → xUnit `Assert.True(<expr>)`
//   expectThrows <call>    → `Assert.Throws<DomainException>(() => <call>)`
//
// The class is colocated with the aggregate's domain folder.  A separate
// test project file is the consumer's responsibility — these files just
// need to be referenced from any xUnit test project that targets net8.0.
// ---------------------------------------------------------------------------

export function renderTestsFile(
  agg: AggregateIR,
  _ctx: BoundedContextIR,
  ns: string,
): string | null {
  if (agg.tests.length === 0) return null;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push("using System;");
  lines.push("using Xunit;");
  lines.push(`using ${ns}.Domain.${upperFirst(plural(agg.name))};`);
  lines.push(`using ${ns}.Domain.Common;`);
  lines.push(`using ${ns}.Domain.ValueObjects;`);
  lines.push(`using ${ns}.Domain.Enums;`);
  lines.push(`using ${ns}.Domain.Ids;`);
  lines.push("");
  lines.push(`namespace ${ns}.Tests.${upperFirst(plural(agg.name))};`);
  lines.push("");
  lines.push(`public sealed class ${agg.name}Tests`);
  lines.push("{");
  for (const t of agg.tests) {
    lines.push(...renderTest(t).map((l) => `    ${l}`));
    lines.push("");
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

function plural(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
}

function renderTest(t: TestIR): string[] {
  const methodName = upperFirst(t.name.replace(/[^A-Za-z0-9]+/g, "_")) || "Test";
  const out: string[] = [];
  out.push(`[Fact(DisplayName = ${JSON.stringify(t.name)})]`);
  out.push(`public void ${methodName}()`);
  out.push(`{`);
  for (const s of t.statements) {
    const rendered = renderTestStmt(s);
    if (rendered) out.push(...rendered.split("\n"));
  }
  out.push(`}`);
  return out;
}

/** Lower an explicit intrinsic value-matcher (`expect(x).toBe(y)`,
 *  optionally `.not.`) to the equivalent xUnit assertion. Returns null
 *  when the expression isn't an explicit matcher so the caller falls back
 *  to the operand-hiding `Assert.True`. */
function renderExplicitMatcherToXUnit(expr: ExprIR): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const sig = intrinsicMatcherSig(expr.member);
  if (!sig || sig.on !== "value") return null;
  let receiver = expr.receiver;
  let negate = false;
  if (
    receiver.kind === "member" &&
    receiver.member === "not" &&
    sig.negatable
  ) {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const actual = renderCsExpr(inner);
  const arg = expr.args[0] !== undefined ? renderCsExpr(expr.args[0]) : "";
  switch (expr.member) {
    case "toBe":
      // xUnit: `Assert.Equal(expected, actual)` / `Assert.NotEqual(...)`.
      return negate
        ? `Assert.NotEqual(${arg}, ${actual});`
        : `Assert.Equal(${arg}, ${actual});`;
    case "toBeGreaterThan":
      return negate
        ? `Assert.False(${actual} > ${arg});`
        : `Assert.True(${actual} > ${arg});`;
    case "toBeGreaterThanOrEqual":
      return negate
        ? `Assert.False(${actual} >= ${arg});`
        : `Assert.True(${actual} >= ${arg});`;
    case "toBeLessThan":
      return negate
        ? `Assert.False(${actual} < ${arg});`
        : `Assert.True(${actual} < ${arg});`;
    case "toBeLessThanOrEqual":
      return negate
        ? `Assert.False(${actual} <= ${arg});`
        : `Assert.True(${actual} <= ${arg});`;
    default:
      return null;
  }
}

function renderTestStmt(s: TestStmtIR): string {
  // See `validateAggregateTestBodies` in src/ir/validate.ts — by the
  // time we reach the generator, only `expect` / `expect-throws` /
  // `let` / `expression` / pure-function `call` survive.
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcherToXUnit(s.expr);
    if (explicit) return `    ${explicit}`;
    return `    Assert.True(${renderCsExpr(s.expr)});`;
  }
  if (s.kind === "expect-throws") {
    return `    Assert.Throws<DomainException>(() => { var __ = ${renderCsExpr(s.expr)}; });`;
  }
  if (s.kind === "let") {
    return `    var ${s.name} = ${renderCsExpr(s.expr)};`;
  }
  if (s.kind === "call") {
    const args = s.args.map((a) => renderCsExpr(a)).join(", ");
    return `    ${upperFirst(s.name)}(${args});`;
  }
  if (s.kind === "expression") {
    return `    ${renderCsExpr(s.expr)};`;
  }
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}
