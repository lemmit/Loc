import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { intrinsicMatcherSig } from "../../../util/intrinsic-matchers.js";
import { upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → xUnit test class.
//
// Each test block becomes a `[Fact]`-decorated method.  Explicit, typed
// matchers (`expect(x).toBe(y)`, `.toBeGreaterThan(…)`, with optional
// `.not.`) lower to AwesomeAssertions fluent calls — the OSS continuation of
// FluentAssertions — so failures name actual and expected operands:
//
//   expect(m.amount).toBe(10.5m)          → m.Amount.Should().Be(10.5m);
//   expect(x).toBeGreaterThan(0)          → x.Should().BeGreaterThan(0);
//   expect(x).not.toBeLessThanOrEqual(0)  → x.Should().NotBeLessThanOrEqualTo(0);
//
// A bare boolean falls back to `Assert.True(<expr>)`; `expectThrows` stays
// on `Assert.Throws<DomainException>` (xUnit + AwesomeAssertions coexist).
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
  lines.push("using AwesomeAssertions;");
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
 *  optionally `.not.`) to an AwesomeAssertions fluent call. Returns null
 *  when the expression isn't an explicit matcher so the caller falls back
 *  to `Assert.True(<expr>)` for a bare boolean. */
function renderExplicitMatcherToAwesome(expr: ExprIR): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const sig = intrinsicMatcherSig(expr.member);
  if (!sig || sig.on !== "value") return null;
  let receiver = expr.receiver;
  let negate = false;
  if (receiver.kind === "member" && receiver.member === "not" && sig.negatable) {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const actual = renderCsExpr(inner);
  const arg = expr.args[0] !== undefined ? renderCsExpr(expr.args[0]) : "";
  // FluentAssertions/AwesomeAssertions verb (post `.Should().`) — `Not`
  // prefix when negated.
  const VERBS: Record<string, string> = {
    toBe: "Be",
    toBeGreaterThan: "BeGreaterThan",
    toBeGreaterThanOrEqual: "BeGreaterThanOrEqualTo",
    toBeLessThan: "BeLessThan",
    toBeLessThanOrEqual: "BeLessThanOrEqualTo",
  };
  const verb = VERBS[expr.member];
  if (!verb) return null;
  const method = negate ? `Not${verb}` : verb;
  return `${actual}.Should().${method}(${arg});`;
}

function renderTestStmt(s: TestStmtIR): string {
  // See `validateAggregateTestBodies` in src/ir/validate/validate.ts — by the
  // time we reach the generator, only `expect` / `expect-throws` /
  // `let` / `expression` / pure-function `call` survive.
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcherToAwesome(s.expr);
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
