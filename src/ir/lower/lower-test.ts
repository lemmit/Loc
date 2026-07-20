// Unit-test lowering — `test "…" { … }` AST → `TestIR` (test-placement.md).
//
// A `test` block is subject-agnostic: it lowers its statements against whatever
// per-subject `Env` the caller supplies (an aggregate's / value object's /
// domain service's scope).  This leaf owns:
//   - the hoisted-test index (`test … for <Subject>` written at context/root),
//     grouped by resolved subject node;
//   - `collectSubjectTests`, which unions a subject's nested + hoisted tests;
//   - `lowerTest` / `expectStmtIR`, the per-block / per-assertion lowerers
//     (the latter also consumed by the e2e-test lowerer in `lower.ts`).
//
// Leaf module: it never imports `lower.ts` (the graph is acyclic — the
// orchestrator imports this and calls `indexHoistedTests` once per project).
import { AstUtils } from "langium";
import {
  type Aggregate,
  type DomainService,
  isAggregate,
  isDomainService,
  isExpectStmt,
  isTestBlock,
  isValueObject,
  type Model,
  type Statement,
  type TestBlock,
  type ValueObject,
} from "../../language/generated/ast.js";
import type { ExprIR, TestIR, TestStmtIR } from "../types/loom-ir.js";
import { lowerExpr } from "./lower-expr.js";
import { lowerStatement } from "./lower-stmt.js";
import { cstText, type Env } from "./lower-types.js";

/** The declaration kinds a `test` may anchor to (Phase 1 aggregate + Phase 2
 *  value object / domain service). */
export type TestSubjectNode = Aggregate | ValueObject | DomainService;

// Hoisted unit tests (`test "…" for <Subject> { … }` written at context or file
// root, outside the subject) grouped by their resolved home AST node.
// Populated once per project via `indexHoistedTests`, consumed by every
// subject's lowerer through `collectSubjectTests`.
let hoistedTestsBySubject: Map<TestSubjectNode, TestBlock[]> = new Map();

/** Scan every document for hoisted `TestBlock`s — those whose container is a
 *  `context` or the file root, i.e. NOT the subject declaration itself — and
 *  index them by the subject their `for` head resolves to.  A nested test
 *  (member of an aggregate / value object / domain service) keeps its
 *  containment path and is skipped here; an unresolved `for` target (a linker
 *  error) drops out via the `?.ref` guard. */
export function indexHoistedTests(models: ReadonlyArray<Model>): void {
  const index = new Map<TestSubjectNode, TestBlock[]>();
  for (const model of models) {
    for (const node of AstUtils.streamAllContents(model)) {
      if (!isTestBlock(node)) continue;
      const c = node.$container;
      if (isAggregate(c) || isValueObject(c) || isDomainService(c)) continue; // nested
      const home = node.target?.ref;
      if (!home) continue; // missing/unresolved `for` — validator/linker owns it
      const list = index.get(home);
      if (list) list.push(node);
      else index.set(home, [node]);
    }
  }
  hoistedTestsBySubject = index;
}

/** Collect a subject's unit tests — its NESTED `test` members plus any HOISTED
 *  `test … for <subject>` blocks routed to it — lowering every one under the
 *  same per-subject `env`.  Nested come first (source order), then hoisted (in
 *  document-scan order), so placement never changes the emitted suite. */
export function collectSubjectTests(
  nested: readonly TestBlock[],
  subject: TestSubjectNode,
  env: Env,
): TestIR[] {
  const tests: TestIR[] = [];
  for (const block of nested) tests.push(lowerTest(block, env));
  for (const block of hoistedTestsBySubject.get(subject) ?? []) tests.push(lowerTest(block, env));
  return tests;
}

export function lowerTest(block: TestBlock, env: Env): TestIR {
  let inner = env;
  const statements: TestStmtIR[] = [];
  for (const s of block.body) {
    if (isExpectStmt(s)) {
      statements.push(expectStmtIR(lowerExpr(s.expr, inner), cstText(s.expr)));
    } else {
      const r = lowerStatement(s as Statement, inner);
      statements.push(r.stmt);
      inner = r.envAfter;
    }
  }
  return { name: block.name, statements, verifiesTestCase: block.verifies?.ref?.name };
}

/** Build the `TestStmtIR` for an `expect(...)` test statement.  The
 *  method-based throw assertion `expect(call).toThrow(N?)` is recognised here
 *  and rewritten into the platform-neutral `expect-throws` IR node — so every
 *  backend renders it as a throw exactly as before — with the optional integer
 *  pinning the rejected HTTP status in an e2e api body.  Every other
 *  `expect(...)` carries a value/locator matcher (`toBe`, `toHaveText`, …); a
 *  bare-boolean `expect` is rejected by the validator (`checkExpectMatcher`). */
export function expectStmtIR(e: ExprIR, source: string): TestStmtIR {
  if (e.kind === "method-call" && e.isIntrinsicMatcher && e.member === "toThrow") {
    const inner = e.receiver.kind === "paren" ? e.receiver.inner : e.receiver;
    const arg = e.args[0];
    const status =
      arg && arg.kind === "literal" && arg.lit === "int" ? Number(arg.value) : undefined;
    return status != null
      ? { kind: "expect-throws", expr: inner, source, status }
      : { kind: "expect-throws", expr: inner, source };
  }
  return { kind: "expect", expr: e, source };
}
