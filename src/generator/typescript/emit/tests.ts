import {
  type AggregateIR,
  type BoundedContextIR,
  type ExprIR,
  operationUsesCurrentUser,
  type TestIR,
  type TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsExpr } from "../render-expr.js";

// A currentUser-gated operation's method signature picks up a trailing
// `currentUser: User` parameter; a domain `test` block has no auth context,
// so calls to such ops are supplied a synthetic full-access actor — admin
// role + non-empty permissions so guards pass and the test exercises the
// op's domain logic.  Cast through `unknown` so it stays valid regardless of
// the system's actual `user { ... }` claim shape.
const TEST_ACTOR =
  '{ id: "00000000-0000-0000-0000-000000000000", role: "admin", permissions: ["*"] } as unknown as import("../auth/user-types").User';

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → vitest test file.
//
// Each test block becomes an `it("name", () => { ... })` case.  Statements
// inside use the same renderer as operation bodies, with two extra forms:
//
//   expect(x).toBe(y)       → vitest `expect(x).toBe(y)` (explicit matcher,
//                              including `.not.<matcher>` negation)
//   expect <bool-expr>      → vitest `expect(<bool-expr>).toBe(true)`
//                              (fallback for bare boolean assertions)
//   expectThrows <call>     → vitest `expect(() => <call>).toThrow()`
//
// The container is a plain test file colocated next to the domain class;
// it imports the aggregate / parts / value objects directly.
// ---------------------------------------------------------------------------

export function renderTestsFile(agg: AggregateIR, ctx: BoundedContextIR): string | null {
  if (agg.tests.length === 0) return null;
  // Render the describe body first so the import set can be narrowed to
  // names actually referenced (per the generated-code Biome gate).
  const body: string[] = [];
  body.push(`describe("${agg.name}", () => {`);
  for (const t of agg.tests) {
    body.push(...renderTest(t, ctx).map((l) => `  ${l}`));
    body.push("");
  }
  body.push(`});`);
  const bodyStr = body.join("\n");
  const refs = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(bodyStr);
  const domainNames = [agg.name, ...agg.parts.map((p) => p.name)].filter(refs);
  const voNames = ctx.valueObjects.map((v) => v.name).filter(refs);
  const enumNames = ctx.enums.map((e) => e.name).filter(refs);
  const usesIds = /\bIds\.\w/.test(bodyStr);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { describe, it, expect } from "vitest";`);
  if (domainNames.length > 0) {
    lines.push(`import { ${domainNames.join(", ")} } from "./${lowerFirst(agg.name)}";`);
  }
  if (voNames.length > 0) {
    lines.push(`import { ${voNames.join(", ")} } from "./value-objects";`);
  }
  if (enumNames.length > 0) {
    lines.push(`import { ${enumNames.join(", ")} } from "./value-objects";`);
  }
  if (usesIds) lines.push(`import * as Ids from "./ids";`);
  lines.push("");
  lines.push(...body);
  return lines.join("\n") + "\n";
}

function renderTest(t: TestIR, ctx: BoundedContextIR): string[] {
  const out: string[] = [];
  out.push(`it(${JSON.stringify(t.name)}, () => {`);
  for (const s of t.statements) {
    const rendered = renderTestStmt(s, ctx);
    if (rendered) out.push(...rendered.split("\n"));
  }
  out.push(`});`);
  return out;
}

/** Render a test-body expression, threading a synthetic actor into calls of
 *  currentUser-gated operations (whose method signature gained a trailing
 *  `currentUser` parameter).  Everything else defers to `renderTsExpr`. */
function renderTestExpr(e: ExprIR, ctx: BoundedContextIR): string {
  if (e.kind === "method-call" && e.receiverType.kind === "entity" && !e.isCollectionOp) {
    const entityName = e.receiverType.name;
    const agg = ctx.aggregates.find((a) => a.name === entityName);
    const op = agg?.operations.find((o) => o.name === e.member);
    if (op && operationUsesCurrentUser(op)) {
      const recv = renderTestExpr(e.receiver, ctx);
      const args = [...e.args.map((a) => renderTestExpr(a, ctx)), TEST_ACTOR];
      return `${recv}.${e.member}(${args.join(", ")})`;
    }
  }
  return renderTsExpr(e);
}

/** Detect `expect(x).<matcher>(y)` / `expect(x).not.<matcher>(y)` — an
 *  explicit intrinsic matcher call wrapped around an `expect` statement.
 *  Returns the vitest line directly (matcher names line up 1:1) so the
 *  inner expression isn't double-wrapped in `.toBe(true)`. Returns null
 *  for bare boolean assertions, which the caller still wraps. */
function renderExplicitMatcher(expr: ExprIR, ctx: BoundedContextIR): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  let receiver = expr.receiver;
  let negate = false;
  if (receiver.kind === "member" && receiver.member === "not") {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const actual = renderTestExpr(inner, ctx);
  const args = expr.args.map((a) => renderTestExpr(a, ctx)).join(", ");
  const tail = negate ? `not.${expr.member}` : expr.member;
  return `  expect(${actual}).${tail}(${args});`;
}

function renderTestStmt(s: TestStmtIR, ctx: BoundedContextIR): string {
  // The IR validator (`validateAggregateTestBodies` in
  // src/ir/validate/validate.ts) rejects mutating statements (`assign` /
  // `add` / `remove` / `emit` / `precondition`) and `call` to a
  // private operation — those need an aggregate instance which a
  // bare test block doesn't have.  By the time we reach the
  // generator, only `expect` / `expect-throws` / `let` / `expression`
  // and `call` to a pure function survive.
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcher(s.expr, ctx);
    if (explicit) return explicit;
    return `  expect(${renderTestExpr(s.expr, ctx)}).toBe(true);`;
  }
  if (s.kind === "expect-throws") {
    return `  expect(() => { ${renderTestExpr(s.expr, ctx)}; }).toThrow();`;
  }
  if (s.kind === "let") {
    return `  const ${s.name} = ${renderTestExpr(s.expr, ctx)};`;
  }
  if (s.kind === "call") {
    // Only pure-function calls reach here (validator-rejected
    // private-operation calls).  Render as a real expression-stmt
    // call so the function fires.
    const args = s.args.map((a) => renderTestExpr(a, ctx)).join(", ");
    return `  ${s.name}(${args});`;
  }
  if (s.kind === "expression") {
    return `  ${renderTestExpr(s.expr, ctx)};`;
  }
  // Other StmtIR kinds (assign / add / remove / emit / precondition)
  // are guaranteed by the validator never to land here.  If they do,
  // it's an internal bug — fail loudly so the issue surfaces in CI.
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}
