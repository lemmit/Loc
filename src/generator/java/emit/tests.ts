import { createInputFields, createOmissionValue } from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  FieldIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { intrinsicMatcherSig } from "../../../util/intrinsic-matchers.js";
import { escapeJavaIdent, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, collectJavaTypeImports, renderJavaExpr } from "../render-expr.js";
import { stubUserValue } from "./auth.js";

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → JUnit 5 test class (the xUnit/vitest analog).
// Each block becomes a @Test method with @DisplayName carrying the source
// name.  Explicit matchers lower to JUnit assertions; `expectThrows` to
// assertThrows(DomainException.class, …); a bare boolean to assertTrue.
// Pure domain tests — no Spring context, they run under plain `mvn test`.
// ---------------------------------------------------------------------------

export function renderJavaTestsFile(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  basePkg: string,
  pkg: string,
  /** System user-block fields — when ops referencing currentUser are
   *  invoked from a test body, a stub test user is materialised with the
   *  dev-stub claim values and threaded as the trailing argument. */
  userFields?: readonly FieldIR[],
): string | null {
  if (agg.tests.length === 0) return null;
  const imports = new Set<string>();
  const state = { usesTestUser: false, userFields, ctx };
  const methods = agg.tests.flatMap((t) => renderTest(t, ctx, imports, state));
  while (methods[methods.length - 1] === "") methods.pop();
  if (state.usesTestUser) {
    for (const f of userFields ?? []) collectJavaTypeImports(f.type, imports);
  }
  return lines(
    `package ${pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    imports.size > 0 ? `` : null,
    `import static org.junit.jupiter.api.Assertions.*;`,
    ``,
    `import org.junit.jupiter.api.DisplayName;`,
    `import org.junit.jupiter.api.Test;`,
    ``,
    state.usesTestUser ? `import ${basePkg}.auth.User;` : null,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `public class ${agg.name}Tests {`,
    ...(state.usesTestUser
      ? [
          `    private static final User __testUser = new User(${(userFields ?? [])
            .map((f) => stubUserValue(f.type))
            .join(", ")});`,
          ``,
        ]
      : []),
    ...methods,
    `}`,
    ``,
  );
}

interface TestEmitState {
  usesTestUser: boolean;
  userFields?: readonly FieldIR[];
  ctx: BoundedContextIR;
}

/** Append the stub test user to top-level op calls whose target
 *  operation references currentUser (the entity method takes a trailing
 *  User parameter). */
function withTestUser(expr: ExprIR, rendered: string, state: TestEmitState): string {
  if (expr.kind !== "method-call" || expr.receiverType.kind !== "entity") return rendered;
  const agg = state.ctx.aggregates.find(
    (a) => a.name === (expr.receiverType as { name: string }).name,
  );
  const op = agg?.operations.find((o) => o.name === expr.member);
  if (!op || !operationUsesCurrentUser(op) || !state.userFields) return rendered;
  state.usesTestUser = true;
  return rendered.replace(/\)$/, expr.args.length > 0 ? ", __testUser)" : "__testUser)");
}

function renderTest(
  t: TestIR,
  ctx: BoundedContextIR,
  imports: Set<string>,
  state: TestEmitState,
): string[] {
  const methodName =
    t.name
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "_$1") || "test";
  const body = t.statements.flatMap((s) => renderTestStmt(s, ctx, imports, state));
  return [
    `    @Test`,
    `    @DisplayName(${JSON.stringify(t.name)})`,
    `    public void ${methodName}() {`,
    ...body,
    `    }`,
    ``,
  ];
}

/** `Agg.create({...})` → the positional `Agg.create(...)` factory call,
 *  omitted create-inputs filled with their omission value (the factory
 *  takes every canonical create-input positionally). */
function renderCreateCall(e: ExprIR, ctx: BoundedContextIR, imports: Set<string>): string | null {
  if (e.kind !== "method-call" || e.member !== "create" || e.args.length !== 1) return null;
  const objArg = e.args[0];
  const receiver = e.receiver;
  if (objArg?.kind !== "object" || receiver.kind !== "ref") return null;
  const agg = ctx.aggregates.find((a) => a.name === receiver.name);
  if (!agg) return null;
  const byName = new Map(objArg.fields.map((f) => [f.name, f.value]));
  const args = createInputFields(agg).map((f) => {
    const v = byName.get(f.name);
    if (v) {
      collectJavaExprImports(v, imports);
      return renderJavaExpr(v);
    }
    const omission = createOmissionValue(f);
    if (omission.kind === "default") {
      collectJavaExprImports(omission.expr, imports);
      return renderJavaExpr(omission.expr);
    }
    return omission.kind === "false" ? "false" : "null";
  });
  return `${agg.name}.create(${args.join(", ")})`;
}

/** Explicit intrinsic matcher → a JUnit assertion.  Comparisons over
 *  BigDecimal receivers route through compareTo (BigDecimal's equals is
 *  scale-sensitive and `<`/`>` don't exist). */
function renderExplicitMatcher(expr: ExprIR, imports: Set<string>): string | null {
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
  collectJavaExprImports(inner, imports);
  const actual = renderJavaExpr(inner);
  const arg = expr.args[0];
  if (arg) collectJavaExprImports(arg, imports);
  const expected = arg !== undefined ? renderJavaExpr(arg) : "";
  const moneyLike =
    (inner.kind === "member" &&
      inner.memberType.kind === "primitive" &&
      (inner.memberType.name === "money" || inner.memberType.name === "decimal")) ||
    (arg?.kind === "literal" && (arg.lit === "money" || arg.lit === "decimal"));
  const cmp = (op: string): string =>
    moneyLike ? `(${actual}).compareTo(${expected}) ${op} 0` : `${actual} ${op} ${expected}`;
  switch (expr.member) {
    case "toBe":
      if (moneyLike) {
        return negate
          ? `assertTrue((${actual}).compareTo(${expected}) != 0);`
          : `assertEquals(0, (${actual}).compareTo(${expected}));`;
      }
      return negate
        ? `assertNotEquals(${expected}, ${actual});`
        : `assertEquals(${expected}, ${actual});`;
    case "toBeGreaterThan":
      return `assert${negate ? "False" : "True"}(${cmp(">")});`;
    case "toBeGreaterThanOrEqual":
      return `assert${negate ? "False" : "True"}(${cmp(">=")});`;
    case "toBeLessThan":
      return `assert${negate ? "False" : "True"}(${cmp("<")});`;
    case "toBeLessThanOrEqual":
      return `assert${negate ? "False" : "True"}(${cmp("<=")});`;
    default:
      return null;
  }
}

function renderTestStmt(
  s: TestStmtIR,
  ctx: BoundedContextIR,
  imports: Set<string>,
  state: TestEmitState,
): string[] {
  // Only expect / expect-throws / let / expression / call survive the IR
  // validator (validateAggregateTestBodies).
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcher(s.expr, imports);
    if (explicit) return [`        ${explicit}`];
    collectJavaExprImports(s.expr, imports);
    return [`        assertTrue(${renderJavaExpr(s.expr)});`];
  }
  if (s.kind === "expect-throws") {
    const expr =
      renderCreateCall(s.expr, ctx, imports) ??
      withTestUser(s.expr, render(s.expr, imports), state);
    return [`        assertThrows(DomainException.class, () -> ${expr});`];
  }
  if (s.kind === "let") {
    const expr =
      renderCreateCall(s.expr, ctx, imports) ??
      withTestUser(s.expr, render(s.expr, imports), state);
    return [`        var ${escapeJavaIdent(s.name)} = ${expr};`];
  }
  if (s.kind === "call") {
    const args = s.args.map((a) => render(a, imports)).join(", ");
    return [`        ${s.name}(${args});`];
  }
  if (s.kind === "expression") {
    const expr =
      renderCreateCall(s.expr, ctx, imports) ??
      withTestUser(s.expr, render(s.expr, imports), state);
    return [`        ${expr};`];
  }
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}

function render(e: ExprIR, imports: Set<string>): string {
  collectJavaExprImports(e, imports);
  return renderJavaExpr(e);
}

void upperFirst;
