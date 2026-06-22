import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  OperationIR,
  TestIR,
  TestStmtIR,
} from "../../ir/types/loom-ir.js";
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
//     / toThrow / field reads) onto it.
//
//   * ASH — an Ash resource has no in-memory object-with-methods, so the
//     happy-path idiom (`create` returns a persisted record; an op mutates it)
//     is data-layer-bound and still skips (pending a DataCase + SQL.Sandbox
//     harness).  But the REJECTION half runs DB-free (Rec3): Ash validations and
//     action `validate` clauses run at *changeset-build* time, so
//     `Ash.Changeset.for_create/for_update(...).valid?` decides an
//     invariant/precondition/VO-construction `toThrow` without touching the data
//     layer:
//
//       expect(Order.create({bad})).toThrow()
//         → refute Ash.Changeset.for_create(Mod, :create, %{…}).valid?
//       expect(Money{ amount: -1 }).toThrow()
//         → refute Ash.Changeset.for_create(MoneyMod, :create, %{…}).valid?
//       let o = Order.create({…confirmed});  expect(o.confirm()).toThrow()
//         → o = %Mod{…};  refute Ash.Changeset.for_update(o, :confirm, %{}).valid?
//
//     A test the renderer still can't lower DB-free (a happy-path op + state
//     assertion) becomes an `@tag :skip` placeholder, name + reason preserved.
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
  // Value objects with a validating constructor (F5 vanilla; an embedded Ash
  // resource with `validations` on Ash) — both emitters lower
  // `expect(VO{bad}).toThrow()` against these.
  const validatableVos = new Set(
    ctx.valueObjects.filter((vo) => voHasConstraints(vo)).map((vo) => vo.name),
  );
  let emitted = false;
  for (const agg of ctx.aggregates) {
    if (agg.tests.length === 0) continue;
    // Vanilla ports the full idiom onto the aggregate's pure domain core
    // (vanilla/tests-emit.ts + domain-core-emit.ts); ash runs the rejection
    // subset DB-free and skips the happy-path remainder (see the file header).
    const content =
      foundation === "vanilla"
        ? renderVanillaAggregateTestModule(agg, contextModule, validatableVos)
        : renderAshAggregateTestModule(agg, contextModule, validatableVos);
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

// ---------------------------------------------------------------------------
// Ash emitter
// ---------------------------------------------------------------------------

interface AshEnv {
  agg: EnrichedAggregateIR;
  /** Fully-qualified module of the aggregate under test, e.g. `App.Ctx.Order`. */
  aggMod: string;
  /** Bounded-context module prefix, e.g. `App.Ctx`. */
  ctxModule: string;
  /** Value objects whose embedded resource carries `validations` — only these
   *  can lower a `expect(VO{bad}).toThrow()` to a changeset-build `valid?` check. */
  validatableVos: Set<string>;
  rctx: RenderCtx;
}

function renderAshAggregateTestModule(
  agg: EnrichedAggregateIR,
  contextModule: string,
  validatableVos: Set<string>,
): string {
  const env: AshEnv = {
    agg,
    aggMod: `${contextModule}.${upperFirst(agg.name)}`,
    ctxModule: contextModule,
    validatableVos,
    rctx: { thisName: "record", contextModule, foundation: "ash" },
  };
  const blocks = agg.tests.map((t) => renderAshTest(t, env));
  return `# Auto-generated.  Do not edit by hand.
defmodule ${env.aggMod}Test do
  use ExUnit.Case, async: true${blocks
    .flatMap((block) => ["", ...block.map((l) => (l === "" ? "" : `  ${l}`))])
    .join("\n")}
end
`;
}

function renderAshTest(t: TestIR, env: AshEnv): string[] {
  try {
    const used = usedRefNames(t.statements);
    const body = t.statements.flatMap((s) => renderAshStmt(s, env, used));
    return [`test ${JSON.stringify(t.name)} do`, ...body.map((l) => `  ${l}`), "end"];
  } catch {
    // The happy-path remainder (a `create` whose record an op mutates and whose
    // post-op state a later `expect` reads) is data-layer-bound → documented skip.
    return renderSkippedTest(t);
  }
}

function renderSkippedTest(t: TestIR): string[] {
  return [
    "@tag :skip",
    `test ${JSON.stringify(t.name)} do`,
    "  # Skipped on the Ash foundation: this domain test asserts post-create /",
    "  # post-operation STATE, which needs a persisted record (an Ash action runs",
    "  # against the data layer). The rejection half (invariant / precondition /",
    "  # value-object construction `toThrow`) runs DB-free above; the happy-path",
    "  # state assertions await a DataCase + SQL.Sandbox harness. See",
    "  # docs/audits/test-parity-generated-backends.md.",
    "  :ok",
    "end",
  ];
}

function renderAshStmt(s: TestStmtIR, env: AshEnv, used: Set<string>): string[] {
  switch (s.kind) {
    case "let": {
      const name = used.has(s.name) ? snake(s.name) : `_${snake(s.name)}`;
      // A bound `create` is a precondition-test setup: build the record as an
      // in-memory struct (Ash resources ARE structs), so a later op-`toThrow`
      // can validate against it without persisting.
      if (isCreate(s.expr)) return [`${name} = ${renderRecordStruct(s.expr, env)}`];
      // Any other binding must be pure (a value-object / literal seed). An op
      // call here would need the data layer → skip the whole test.
      if (containsImpure(s.expr, env)) throw new Error("impure let binding");
      return [`${name} = ${renderExpr(s.expr, env.rctx)}`];
    }
    case "expect":
      if (containsImpure(s.expr, env)) throw new Error("impure expect");
      return [renderAshExpect(s.expr, env)];
    case "expect-throws":
      return [renderAshThrows(s.expr, env)];
    default:
      // A bare op call (state threading) or any mutating statement is
      // data-layer-bound on Ash → skip.
      throw new Error(`ash test: unsupported statement '${s.kind}'`);
  }
}

/** Lower one pure `expect(<actual>).<matcher>(<expected>)` (optionally `.not.`)
 *  to an `assert`/`refute` line over in-memory structs. */
function renderAshExpect(expr: ExprIR, env: AshEnv): string {
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
  if (!op) throw new Error(`ash test: unsupported value matcher '${expr.member}'.`);
  const actual = renderExpr(inner, env.rctx);
  const arg = expr.args[0];
  const expected = arg ? renderExpr(arg, env.rctx) : "";
  const cmp = `${actual} ${op} ${expected}`;
  return negate ? `refute ${cmp}` : `assert ${cmp}`;
}

/** Lower an `expect(<call>).toThrow()` to a DB-free `refute …valid?`.  Throws
 *  (→ test skipped) for any shape that can't be checked at changeset build. */
function renderAshThrows(expr: ExprIR, env: AshEnv): string {
  const inner = expr.kind === "paren" ? expr.inner : expr;

  // Aggregate create invariant — the resource's `validations` (and any cast
  // failure) run at changeset build, so an invalid input yields `valid?: false`.
  if (isCreate(inner) && inner.kind === "method-call") {
    const mod =
      inner.receiver.kind === "ref"
        ? `${env.ctxModule}.${upperFirst(inner.receiver.name)}`
        : env.aggMod;
    return `refute Ash.Changeset.for_create(${mod}, :create, ${renderInputMap(inner.args[0], env)}).valid?`;
  }

  // Value-object construction invariant — the embedded resource's `validations`
  // run when its own create changeset is built.
  if (
    inner.kind === "call" &&
    inner.callKind === "value-object-ctor" &&
    env.validatableVos.has(inner.name)
  ) {
    const voMod = `${env.ctxModule}.${upperFirst(inner.name)}`;
    return `refute Ash.Changeset.for_create(${voMod}, :create, ${renderCtorMap(inner, env)}).valid?`;
  }

  // Operation precondition — the action's `validate` clause reads
  // `changeset.data` (the in-memory record), so it runs without a load.  Only
  // lowered when the op actually declares a precondition (otherwise the
  // changeset would be valid and the assertion would wrongly fail).
  if (inner.kind === "method-call" && isAggOp(inner, env)) {
    const opDef = findOp(inner.member, env);
    if (!opDef || !hasPrecondition(opDef)) {
      throw new Error("ash test: operation toThrow without a precondition is not DB-free");
    }
    const recv = renderExpr(inner.receiver, env.rctx);
    const params = inner.args
      .map((a, i) => `${snake(opDef.params[i]?.name ?? `arg${i}`)}: ${renderExpr(a, env.rctx)}`)
      .join(", ");
    return `refute Ash.Changeset.for_update(${recv}, :${snake(opDef.name)}, %{${params}}).valid?`;
  }

  throw new Error("ash test: toThrow over a non-rejection expression is not DB-free");
}

/** Build the in-memory record struct from a `create({...})` argument —
 *  `%App.Ctx.Order{customer: "acme", status: "confirmed", price: %App.Ctx.Money{…}}`.
 *  Used as the precondition-test subject (an op `for_update` validates against
 *  it).  Value-object fields render as their embedded struct via `renderExpr`. */
function renderRecordStruct(create: ExprIR, env: AshEnv): string {
  if (create.kind !== "method-call") throw new Error("renderRecordStruct: not a create call");
  const arg = create.args[0];
  const mod =
    create.receiver.kind === "ref"
      ? `${env.ctxModule}.${upperFirst(create.receiver.name)}`
      : env.aggMod;
  const fields =
    arg && arg.kind === "object"
      ? arg.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, env.rctx)}`).join(", ")
      : "";
  return `%${mod}{${fields}}`;
}

/** Render an aggregate `create({...})` object literal as an Ash action input
 *  MAP (`%{customer: "", price: %{amount: -1.0, currency: "USD"}}`).  Nested
 *  value objects stay maps so Ash casts (and validates) them as embeds. */
function renderInputMap(arg: ExprIR | undefined, env: AshEnv): string {
  if (!arg || arg.kind !== "object") return "%{}";
  const fields = arg.fields.map((f) => `${snake(f.name)}: ${renderInputValue(f.value, env)}`);
  return `%{${fields.join(", ")}}`;
}

/** Render a value-object constructor (`Money{ amount: -1, currency: "USD" }`) as
 *  an Ash action input MAP for its embedded resource's create changeset. */
function renderCtorMap(ctor: ExprIR, env: AshEnv): string {
  if (ctor.kind !== "call") throw new Error("renderCtorMap: not a ctor call");
  const names = ctor.argNames ?? [];
  const fields = ctor.args.map(
    (a, i) => `${snake(names[i] ?? `f${i}`)}: ${renderInputValue(a, env)}`,
  );
  return `%{${fields.join(", ")}}`;
}

/** A value inside an Ash input map: a nested value object stays a map (Ash casts
 *  embeds from maps); everything else renders as its Elixir expression. */
function renderInputValue(e: ExprIR, env: AshEnv): string {
  if (e.kind === "object") return renderInputMap(e, env);
  if (e.kind === "call" && e.callKind === "value-object-ctor") return renderCtorMap(e, env);
  return renderExpr(e, env.rctx);
}

// ---------------------------------------------------------------------------
// Classification + walkers
// ---------------------------------------------------------------------------

function isCreate(e: ExprIR): boolean {
  return e.kind === "method-call" && e.member === "create" && !e.isIntrinsicMatcher;
}

/** A call to one of the aggregate's declared operations (by name — receiver
 *  types are unreliable in test position; collection-ops / matchers excluded). */
function isAggOp(e: ExprIR, env: AshEnv): boolean {
  return (
    e.kind === "method-call" &&
    !e.isCollectionOp &&
    !e.isIntrinsicMatcher &&
    e.member !== "create" &&
    findOp(e.member, env) !== undefined
  );
}

function findOp(member: string, env: AshEnv): OperationIR | undefined {
  return env.agg.operations.find((o) => o.name === member);
}

function hasPrecondition(op: OperationIR): boolean {
  return op.statements.some((s) => s.kind === "precondition");
}

/** True when `e` or any sub-expression is an aggregate `create`/op call — i.e.
 *  data-layer-bound, not renderable in a pure (DB-free) position. */
function containsImpure(e: ExprIR, env: AshEnv): boolean {
  return anyExpr(e, (n) => isCreate(n) || isAggOp(n, env));
}

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

function stmtExprs(s: TestStmtIR): ExprIR[] {
  if (s.kind === "expect" || s.kind === "expect-throws" || s.kind === "let") return [s.expr];
  if (s.kind === "expression") return [s.expr];
  if (s.kind === "call") return s.args;
  return [];
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
