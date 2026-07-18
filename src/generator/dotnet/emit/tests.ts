import { createInputFields, createOmissionValue } from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { intrinsicMatcherSig } from "../../../util/intrinsic-matchers.js";
import { escapeCsharpIdent, upperFirst } from "../../../util/naming.js";
import { renderCsExpr } from "../render-expr.js";

// A currentUser-gated operation's method signature picks up a trailing
// `User currentUser` parameter; a domain `test` block has no auth context, so
// calls to such ops are supplied a synthetic full-access actor (admin + `*`
// permission) — parity with the Hono backend's TEST_ACTOR.
const TEST_ACTOR = 'new User(System.Guid.Empty, "admin", new List<string> { "*" })';

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
// Every `expect` carries a matcher (no bare-boolean fallback);
// `expect(call).toThrow()` emits `Assert.Throws<DomainException>` (xUnit +
// AwesomeAssertions coexist).
// ---------------------------------------------------------------------------

export function renderTestsFile(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  ns: string,
): string | null {
  if (agg.tests.length === 0) return null;
  // Render the test bodies first so we know whether the synthetic actor
  // (TEST_ACTOR) was threaded into any currentUser-gated op call — only then do
  // we import its `List<string>` + Auth-layer `User` dependencies (a system
  // with no `user` block emits no `${ns}.Auth` namespace, so an unconditional
  // import would not compile).
  const methodBlocks = agg.tests.map((t) => renderTest(t, ctx).map((l) => `    ${l}`));
  const usesActor = methodBlocks.some((b) => b.some((l) => l.includes(TEST_ACTOR)));

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push("using System;");
  if (usesActor) lines.push("using System.Collections.Generic;");
  lines.push("using Xunit;");
  lines.push("using AwesomeAssertions;");
  lines.push(`using ${ns}.Domain.${upperFirst(plural(agg.name))};`);
  lines.push(`using ${ns}.Domain.Common;`);
  lines.push(`using ${ns}.Domain.ValueObjects;`);
  lines.push(`using ${ns}.Domain.Enums;`);
  lines.push(`using ${ns}.Domain.Ids;`);
  if (usesActor) lines.push(`using ${ns}.Auth;`);
  lines.push("");
  lines.push(`namespace ${ns}.Tests.${upperFirst(plural(agg.name))};`);
  lines.push("");
  lines.push(`public sealed class ${agg.name}Tests`);
  lines.push("{");
  for (const block of methodBlocks) {
    lines.push(...block);
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

function renderTest(t: TestIR, ctx: BoundedContextIR): string[] {
  const methodName = upperFirst(t.name.replace(/[^A-Za-z0-9]+/g, "_")) || "Test";
  const out: string[] = [];
  out.push(`[Fact(DisplayName = ${JSON.stringify(t.name)})]`);
  out.push(`public void ${methodName}()`);
  out.push(`{`);
  for (const s of t.statements) {
    const rendered = renderTestStmt(s, ctx);
    if (rendered) out.push(...rendered.split("\n"));
  }
  out.push(`}`);
  return out;
}

/** Render an aggregate `Agg.create({...})` factory call as a named-arg
 *  `Agg.Create(...)` — the same shape the workflow `factory-let` emitter
 *  produces.  The .NET `Create(...)` factory takes *every* canonical
 *  create-input as a positional parameter (no C# defaults), so a test
 *  create that names only a subset must supply each omitted input
 *  explicitly with its omission value (optional → `null`, bare `bool` →
 *  `false`, `= default` → the default literal) or the call fails to
 *  compile (CS7036).  Named args keep the source field order free.
 *
 *  Returns `null` when the expression isn't an aggregate create call, so
 *  the caller falls back to the generic expression renderer (a bare
 *  `object` literal would otherwise render as a C# `new { … }`, which is
 *  not a valid argument to the positional `Create(...)`). */
function renderCreateCall(e: ExprIR, ctx: BoundedContextIR): string | null {
  if (e.kind !== "method-call" || e.member !== "create" || e.args.length !== 1) return null;
  const objArg = e.args[0];
  const receiver = e.receiver;
  if (objArg?.kind !== "object" || receiver.kind !== "ref") return null;
  const agg = ctx.aggregates.find((a) => a.name === receiver.name);
  if (!agg) return null;
  const provided = objArg.fields.map((f) => `${f.name}: ${renderCsExpr(f.value)}`);
  const named = new Set(objArg.fields.map((f) => f.name));
  const omitted = createInputFields(agg)
    .filter((f) => !named.has(f.name))
    .map((f) => {
      const v = createOmissionValue(f);
      const value =
        v.kind === "default" ? renderCsExpr(v.expr) : v.kind === "false" ? "false" : "null";
      return `${f.name}: ${value}`;
    });
  return `${agg.name}.Create(${[...provided, ...omitted].join(", ")})`;
}

/** Lower an explicit intrinsic value-matcher (`expect(x).toBe(y)`,
 *  optionally `.not.`) to an AwesomeAssertions fluent call. Returns null
 *  when the expression isn't an explicit matcher so the caller falls back
 *  to `Assert.True(<expr>)` for a bare boolean. */
function renderExplicitMatcherToAwesome(expr: ExprIR): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const sig = intrinsicMatcherSig(expr.member);
  if (sig?.on !== "value") return null;
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

function renderTestStmt(s: TestStmtIR, ctx: BoundedContextIR): string {
  // See `validateAggregateTestBodies` in src/ir/validate/validate.ts — by the
  // time we reach the generator, only `expect` / `expect-throws` /
  // `let` / `expression` / pure-function `call` survive.
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcherToAwesome(s.expr);
    if (explicit) return `    ${explicit}`;
    // Every `expect` carries a matcher (validator: checkExpectMatcher); a bare
    // boolean reaching codegen is an invariant violation, not user input.
    throw new Error("expect requires a matcher (e.g. expect(x).toBe(y)); got a bare expression.");
  }
  if (s.kind === "expect-throws") {
    const expr = renderTestExpr(s.expr, ctx);
    // An invocation (operation call) is a valid expression-statement whether it
    // returns void or a value — `() => { call(); }`.  Only a non-invocation
    // expression (e.g. a property access) needs binding to satisfy CS0201;
    // binding a void call to `var` is a CS0815 error, so never do it for calls.
    const isInvocation = s.expr.kind === "method-call" || s.expr.kind === "call";
    const body = isInvocation ? `${expr};` : `var __ = ${expr};`;
    return `    Assert.Throws<DomainException>(() => { ${body} });`;
  }
  if (s.kind === "let") {
    const expr = renderTestExpr(s.expr, ctx);
    return `    var ${escapeCsharpIdent(s.name)} = ${expr};`;
  }
  if (s.kind === "call") {
    const args = s.args.map((a) => renderCsExpr(a)).join(", ");
    return `    ${upperFirst(s.name)}(${args});`;
  }
  if (s.kind === "expression") {
    return `    ${renderTestExpr(s.expr, ctx)};`;
  }
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}

/** Render a test-body expression, threading the synthetic actor (TEST_ACTOR)
 *  into calls of currentUser-gated operations (whose method signature gained a
 *  trailing `User currentUser` parameter).  Everything else defers to
 *  `renderCreateCall` (typed `create({…})` input) / `renderCsExpr`. */
function renderTestExpr(e: ExprIR, ctx: BoundedContextIR): string {
  if (e.kind === "method-call" && e.receiverType.kind === "entity" && !e.isCollectionOp) {
    const entityName = e.receiverType.name;
    const agg = ctx.aggregates.find((a) => a.name === entityName);
    const op = agg?.operations.find((o) => o.name === e.member);
    if (op && operationUsesCurrentUser(op)) {
      const recv = renderTestExpr(e.receiver, ctx);
      const args = [...e.args.map((a) => renderTestExpr(a, ctx)), TEST_ACTOR];
      return `${recv}.${upperFirst(e.member)}(${args.join(", ")})`;
    }
  }
  return renderCreateCall(e, ctx) ?? renderCsExpr(e);
}
