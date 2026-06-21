import type {
  EnrichedBoundedContextIR,
  ExprIR,
  TestIR,
  TestStmtIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";
import { voHasConstraints } from "./vanilla/changeset-validators.js";
import { renderVanillaAggregateTestModule } from "./vanilla/tests-emit.js";

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → ExUnit test module (the vitest/xUnit/pytest/JUnit
// sibling).  This closes the Phoenix half of the domain-test parity gap
// (docs/audits/test-parity-generated-backends.md, F1).
//
// The two foundations diverge because their domain models do:
//
//   * VANILLA (Ecto/Phoenix) — we control the code, so the aggregate carries a
//     PURE domain core (`vanilla/domain-core-emit.ts`): `create/1` validates via
//     `apply_action` and each op runs precondition + in-memory mutation, both
//     Repo-free.  `vanilla/tests-emit.ts` ports the full Loom idiom (create / op
//     / toThrow / field reads) onto it — nothing is skipped except value-object
//     construction invariants (a vanilla VO is an unvalidated map — a real
//     runtime gap, flagged with a documented `@tag :skip`).
//
//   * ASH — an Ash resource validates only through the data layer (actions run
//     against a live DB) and has no in-memory object-with-methods.  So this file
//     emits the PURE SUBSET: a runnable `test` only for an in-memory body
//     (value-object construction + field reads via `expect(x).<cmp>(y)`); a test
//     that calls `create`/operations or asserts a construction-time `toThrow`
//     becomes an `@tag :skip` placeholder (name + reason preserved) pending a
//     DB-backed `mix test` harness.
// ---------------------------------------------------------------------------

type Foundation = "ash" | "vanilla";

// Comparison value-matchers → an Elixir operator.  A portable test asserts
// over the value-object STRUCT it built directly (`%Money{amount: 10.5}`), not a
// DB-cast record, so a money/decimal field holds the bare literal it was
// constructed with — both operands render identically, and plain operators
// compare correctly (no Decimal coercion needed, since the construction path
// inserts none here).
const MATCHER_OP: Record<string, string> = {
  toBe: "==",
  toBeGreaterThan: ">",
  toBeGreaterThanOrEqual: ">=",
  toBeLessThan: "<",
  toBeLessThanOrEqual: "<=",
};

/** Emit one `test/<ctx>/<agg>_test.exs` per aggregate that declares `test`
 *  blocks.  Returns true if any file was emitted (so the orchestrator knows to
 *  emit the once-per-project `test/test_helper.exs`). */
export function emitAggregateTests(
  ctx: EnrichedBoundedContextIR,
  appModule: string,
  foundation: Foundation,
  out: Map<string, string>,
): boolean {
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  // Value objects with a validating constructor (F5) — the vanilla emitter
  // lowers `expect(VO{bad}).toThrow()` against these (`<VO>.new/1`).
  const validatableVos = new Set(
    ctx.valueObjects.filter((vo) => voHasConstraints(vo)).map((vo) => vo.name),
  );
  let emitted = false;
  for (const agg of ctx.aggregates) {
    if (agg.tests.length === 0) continue;
    // Vanilla ports the full idiom onto the aggregate's pure domain core
    // (vanilla/tests-emit.ts + domain-core-emit.ts); ash stays the pure-subset
    // (Ash actions are data-layer-bound — see the file header).
    const content =
      foundation === "vanilla"
        ? renderVanillaAggregateTestModule(agg, contextModule, validatableVos)
        : renderAggregateTestModule(agg.name, agg.tests, contextModule, foundation);
    out.set(`test/${snake(ctx.name)}/${snake(agg.name)}_test.exs`, content);
    emitted = true;
  }
  return emitted;
}

/** The once-per-project `test/test_helper.exs` (`ExUnit.start()`); the shells
 *  don't emit one, and `mix test` requires it. */
export function emitTestHelper(out: Map<string, string>): void {
  out.set("test/test_helper.exs", "ExUnit.start()\n");
}

function renderAggregateTestModule(
  aggName: string,
  tests: readonly TestIR[],
  contextModule: string,
  foundation: Foundation,
): string {
  const rctx: RenderCtx = { thisName: "record", contextModule, foundation };
  const blocks = tests.map((t) => renderTest(t, rctx));
  return `${lines(
    "# Auto-generated.  Do not edit by hand.",
    `defmodule ${contextModule}.${upperFirst(aggName)}Test do`,
    "  use ExUnit.Case, async: true",
    ...blocks.flatMap((block) => ["", ...block.map((l) => (l === "" ? "" : `  ${l}`))]),
    "end",
  )}\n`;
}

function renderTest(t: TestIR, rctx: RenderCtx): string[] {
  if (!isPortable(t)) return renderSkippedTest(t);
  const used = usedRefNames(t.statements);
  const body = t.statements.flatMap((s) => renderStmt(s, rctx, used));
  return [`test ${JSON.stringify(t.name)} do`, ...body.map((l) => `  ${l}`), "end"];
}

function renderSkippedTest(t: TestIR): string[] {
  return [
    "@tag :skip",
    `test ${JSON.stringify(t.name)} do`,
    "  # Skipped on Phoenix/Elixir: this domain test calls aggregate",
    "  # `create`/operations or asserts a construction-time `toThrow` invariant,",
    "  # which Ash actions / Ecto changesets only run against a live DB — there is",
    "  # no pure in-memory factory like the other backends. Runs once a DB-backed",
    "  # `mix test` harness lands. See docs/audits/test-parity-generated-backends.md.",
    "  :ok",
    "end",
  ];
}

function renderStmt(s: TestStmtIR, rctx: RenderCtx, used: Set<string>): string[] {
  if (s.kind === "expect") return [renderExpect(s.expr, rctx)];
  if (s.kind === "let") {
    // Prefix an unreferenced binding with `_` so `mix test` stays
    // warning-clean (the value-object seed line of an assertion-only test).
    const name = used.has(s.name) ? snake(s.name) : `_${snake(s.name)}`;
    return [`${name} = ${renderExpr(s.expr, rctx)}`];
  }
  if (s.kind === "expression") return [renderExpr(s.expr, rctx)];
  if (s.kind === "call") {
    const args = s.args.map((a) => renderExpr(a, rctx)).join(", ");
    return [`${snake(s.name)}(${args})`];
  }
  // `expect-throws` is filtered by isPortable; mutating kinds are rejected by
  // the IR validator (validateAggregateTestBodies).  Reaching here is a bug.
  throw new Error(
    `internal: elixir test body contains '${s.kind}' which should have been filtered/rejected`,
  );
}

/** Lower one `expect(<actual>).<matcher>(<expected>)` (optionally `.not.`) to an
 *  `assert`/`refute` line.  Money/decimal operands route through `Decimal`. */
function renderExpect(expr: ExprIR, rctx: RenderCtx): string {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) {
    throw new Error("expect requires a matcher (e.g. expect(x).toBe(y)); got a bare expression.");
  }
  let receiver = expr.receiver;
  let negate = false;
  if (receiver.kind === "member" && receiver.member === "not") {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const op = MATCHER_OP[expr.member];
  if (!op) throw new Error(`elixir test: unsupported value matcher '${expr.member}'.`);
  const actual = renderExpr(inner, rctx);
  const arg = expr.args[0];
  const expected = arg ? renderExpr(arg, rctx) : "";
  const cmp = `${actual} ${op} ${expected}`;
  return negate ? `refute ${cmp}` : `assert ${cmp}`;
}

// ---------------------------------------------------------------------------
// Portability classification
// ---------------------------------------------------------------------------

/** A test is portable to a pure ExUnit `test` iff no statement needs the DB /
 *  an instance method / construction-time validation (see the file header). */
function isPortable(t: TestIR): boolean {
  for (const s of t.statements) {
    if (s.kind === "expect-throws") return false;
    if (stmtExprs(s).some((e) => anyExpr(e, isImpureNode))) return false;
  }
  return true;
}

/** An impure expression node: an aggregate `create(...)`, or an instance
 *  method-call on an aggregate / value object (Elixir has no instance methods —
 *  these are DB actions or would mis-render).  Collection ops and intrinsic
 *  matchers are pure and excluded. */
function isImpureNode(e: ExprIR): boolean {
  if (e.kind !== "method-call") return false;
  if (e.isCollectionOp || e.isIntrinsicMatcher) return false;
  if (e.member === "create") return true;
  return e.receiverType.kind === "entity" || e.receiverType.kind === "valueobject";
}

function stmtExprs(s: TestStmtIR): ExprIR[] {
  if (s.kind === "expect" || s.kind === "expect-throws" || s.kind === "let") return [s.expr];
  if (s.kind === "expression") return [s.expr];
  if (s.kind === "call") return s.args;
  return [];
}

/** True when `pred` holds for `e` or any sub-expression. */
function anyExpr(e: ExprIR, pred: (e: ExprIR) => boolean): boolean {
  if (pred(e)) return true;
  return childExprs(e).some((c) => anyExpr(c, pred));
}

function usedRefNames(statements: readonly TestStmtIR[]): Set<string> {
  const used = new Set<string>();
  const collect = (e: ExprIR): void => {
    if (e.kind === "ref") used.add(e.name);
    for (const c of childExprs(e)) collect(c);
  };
  for (const s of statements) for (const e of stmtExprs(s)) collect(e);
  return used;
}

/** Direct sub-expressions of `e` — total over `ExprIR.kind` (mirrors the
 *  walkers in `system/e2e-render.ts`). */
function childExprs(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "member":
      return [e.receiver];
    case "method-call":
      return [e.receiver, ...e.args];
    case "call":
      return e.args;
    case "lambda":
      return e.body ? [e.body] : [];
    case "new":
    case "object":
      return e.fields.map((f) => f.value);
    case "paren":
      return [e.inner];
    case "unary":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "convert":
      return [e.value];
    case "list":
      return e.elements;
    case "match":
      return [...e.arms.flatMap((a) => [a.cond, a.value]), ...(e.otherwise ? [e.otherwise] : [])];
    default:
      return [];
  }
}
