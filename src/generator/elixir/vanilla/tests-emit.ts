import type {
  AggregateIR,
  ExprIR,
  OperationIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { elixirString, escapeElixirIdent, snake, upperFirst } from "../../../util/naming.js";
import { opUsesCurrentUser } from "../domain/predicates.js";

// ---------------------------------------------------------------------------
// Vanilla (Ecto/Phoenix) domain `test "..."` → runnable ExUnit, ported 1:1 from
// the Loom test idiom onto the aggregate's PURE DOMAIN CORE (domain-core-emit.ts):
//
//   let p = Agg.create({...})            →  {:ok, p} = Agg.create(%{...})
//   expect(Agg.create({bad})).toThrow()  →  assert {:error, _} = Agg.create(%{...})
//   p.op(x)                              →  p = Agg.op(p, %{"x" => ...})  (threads state)
//   expect(p.op(bad)).toThrow()          →  assert_raise ArgumentError, fn -> Agg.op(p, %{...}) end
//   expect(p.field).toBe(v)              →  assert p.field == v   (money/decimal via Decimal)
//
// All DB-free: `create/1` runs `apply_action` (validations, no Repo); an op core
// raises its precondition before any persist and mutates the struct in memory.
// Verified end-to-end against a generated project (`mix test`, no database).
//
// Operation calls are recognised by NAME (the aggregate's declared operations),
// not by `receiverType` — a `let p = Agg.create(...)` binding is only weakly
// typed in test position, so the receiver type can't be trusted.
//
// A value-object construction invariant (`expect(Money{ amount: -1 }).toThrow()`)
// lowers to the VO's validating constructor — `assert {:error, _} =
// Money.new(%{…})` (F5; valueobject-emit.ts) — when the VO declares an invariant.
// Anything this renderer still can't faithfully lower (a VO with no invariant,
// an unexpected shape) is emitted as a documented `@tag :skip`, never broken Elixir.
// ---------------------------------------------------------------------------

interface Env {
  agg: AggregateIR;
  /** Fully-qualified module of the aggregate under test, e.g. `App.Ctx.Order`. */
  aggMod: string;
  /** Bounded-context module prefix, e.g. `App.Ctx`. */
  ctxModule: string;
  /** Value objects that have a validating constructor (`<VO>.new/1`, F5) — only
   *  these can lower a `expect(VO{bad}).toThrow()` to `assert {:error, _} =
   *  <VO>.new(…)`; a VO without invariants has no module, so such a test skips. */
  validatableVos: Set<string>;
}

const MATCHER_OP: Record<string, string> = {
  toBe: "==",
  toBeGreaterThan: ">",
  toBeGreaterThanOrEqual: ">=",
  toBeLessThan: "<",
  toBeLessThanOrEqual: "<=",
};

/** Decimal comparison tail per matcher — `Decimal.compare/2` returns
 *  `:lt | :eq | :gt`, scale-insensitive (unlike `==` on `%Decimal{}`). */
const MONEY_CMP: Record<string, string> = {
  toBeGreaterThan: "== :gt",
  toBeGreaterThanOrEqual: "in [:gt, :eq]",
  toBeLessThan: "== :lt",
  toBeLessThanOrEqual: "in [:lt, :eq]",
};

// A synthetic privileged actor threaded into a currentUser-gated op call in a
// domain test (the pure-core fn gained a trailing `current_user \\ nil` arg —
// §11d).  A bare test block has no auth context, so without this the guard reads
// a nil actor (`nil.role` → BadMapError, not the ArgumentError a `requires`
// raises) and the test mis-fails.  Mirror of node's `TEST_ACTOR` (emit/tests.ts):
// a map satisfying the common guard fields (role/permissions/id) — Elixir `.field`
// access works on a plain map, so no `%User{}` struct is needed.
const TEST_ACTOR =
  '%{id: "00000000-0000-0000-0000-000000000000", role: "admin", permissions: ["*"]}';

/** A domain `test` shape the vanilla ExUnit emitter deliberately cannot lower to
 *  the pure domain core — an unsupported matcher/statement/expression, or a
 *  `toThrow` over a non-create/op/validatable-VO expression. This is the ONLY
 *  error class that degrades a test to `@tag :skip`; every other throw is a real
 *  emitter bug and must propagate loudly rather than masquerade as an
 *  "unsupported shape" skip that leaves `behavioral-e2e-elixir` green while the
 *  domain suite silently shrinks. Carries a one-line reason surfaced both in the
 *  emitted skip comment and to the no-silent-skip conformance gate
 *  (test/conformance/elixir-domain-test-no-silent-skip.test.ts). */
export class UnsupportedTestShapeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnsupportedTestShapeError";
  }
}

/** The `@tag :skip` body, carrying the concrete reason so a human reading the
 *  generated file (and the conformance gate) sees WHY the port degraded. */
function skipBody(reason: string): string[] {
  return [
    "  # Skipped on vanilla Elixir: this emitter can't lower the test to the pure",
    `  # domain core.  Reason: ${reason}`,
    "  # See docs/audits/test-parity-generated-backends.md.",
    "  :ok",
  ];
}

export function renderVanillaAggregateTestModule(
  agg: AggregateIR,
  contextModule: string,
  validatableVos: Set<string>,
): string {
  const env: Env = {
    agg,
    aggMod: `${contextModule}.${upperFirst(agg.name)}`,
    ctxModule: contextModule,
    validatableVos,
  };
  const blocks = agg.tests.map((t) => renderTest(t, env));
  const body = blocks.flatMap((block) => ["", ...block.map((l) => (l === "" ? "" : `  ${l}`))]);
  return `# Auto-generated.  Do not edit by hand.
defmodule ${env.aggMod}Test do
  use ExUnit.Case, async: true${body.length > 0 ? `\n${body.join("\n")}` : ""}
end
`;
}

function renderTest(t: TestIR, env: Env): string[] {
  try {
    const used = usedRefNames(t.statements);
    const lines = t.statements.flatMap((s) => renderStmt(s, env, used));
    return [`test ${elixirString(t.name)} do`, ...lines.map((l) => `  ${l}`), "end"];
  } catch (err) {
    // ONLY a deliberate "can't lower this shape" signal degrades to a skip
    // (VO-construction invariants, VO instance methods, exotic shapes) — never
    // broken Elixir. Any OTHER error is a real emitter bug and propagates: it
    // would otherwise be swallowed as a benign skip and pass CI green.
    if (!(err instanceof UnsupportedTestShapeError)) throw err;
    return ["@tag :skip", `test ${elixirString(t.name)} do`, ...skipBody(err.message), "end"];
  }
}

function renderStmt(s: TestStmtIR, env: Env, used: Set<string>): string[] {
  switch (s.kind) {
    case "let": {
      const name = used.has(s.name) ? escapeElixirIdent(snake(s.name)) : `_${snake(s.name)}`;
      if (isCreate(s.expr)) {
        // A bound create is the happy path → bind the {:ok, _} struct.
        return [`{:ok, ${name}} = ${renderCreate(s.expr, env)}`];
      }
      return [`${name} = ${vtExpr(s.expr, env)}`];
    }
    case "expect":
      return [renderExpect(s.expr, env)];
    case "expect-throws":
      return [renderThrows(s.expr, env)];
    case "expression": {
      // A bare operation call is state-threading setup: `p.confirm()` →
      // rebind the receiver to the returned (mutated) struct.
      if (s.expr.kind === "method-call" && isAggOp(s.expr, env)) {
        return [`${vtExpr(s.expr.receiver, env)} = ${renderOp(s.expr, env)}`];
      }
      return [vtExpr(s.expr, env)];
    }
    case "call":
      return [`${snake(s.name)}(${s.args.map((a) => vtExpr(a, env)).join(", ")})`];
    default:
      // assign / add / remove / return etc. don't appear at test top-level.
      throw new UnsupportedTestShapeError(`unsupported test statement '${s.kind}'`);
  }
}

function renderExpect(expr: ExprIR, env: Env): string {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) {
    throw new UnsupportedTestShapeError("expect requires a matcher");
  }
  let receiver = expr.receiver;
  let negate = false;
  if (receiver.kind === "member" && receiver.member === "not") {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const op = MATCHER_OP[expr.member];
  if (!op) throw new UnsupportedTestShapeError(`unsupported value matcher '${expr.member}'`);
  const actual = vtExpr(inner, env);
  const arg = expr.args[0];
  const expected = arg ? vtExpr(arg, env) : "";
  const verb = (s: string): string => (negate ? `refute ${s}` : `assert ${s}`);

  if (isMoneyLike(inner, arg)) {
    if (expr.member === "toBe") return verb(`Decimal.equal?(${actual}, ${expected})`);
    return verb(`Decimal.compare(${actual}, ${expected}) ${MONEY_CMP[expr.member]}`);
  }
  return verb(`${actual} ${op} ${expected}`);
}

function renderThrows(expr: ExprIR, env: Env): string {
  const inner = expr.kind === "paren" ? expr.inner : expr;
  if (isCreate(inner)) {
    // A failed create returns {:error, changeset}; it does not raise.
    return `assert {:error, _} = ${renderCreate(inner, env)}`;
  }
  if (inner.kind === "method-call" && isAggOp(inner, env)) {
    // A failed precondition raises ArgumentError before any persist.
    return `assert_raise ArgumentError, fn -> ${renderOp(inner, env)} end`;
  }
  // A value-object construction invariant (F5): `expect(Money{-1}).toThrow()` →
  // the VO's validating constructor returns {:error, _}.  Only VOs that declare
  // an invariant have a `new/1` module; anything else can't be checked in memory.
  if (
    inner.kind === "call" &&
    inner.callKind === "value-object-ctor" &&
    env.validatableVos.has(inner.name)
  ) {
    const voMod = `${env.ctxModule}.${upperFirst(inner.name)}`;
    return `assert {:error, _} = ${voMod}.new(${vtExpr(inner, env)})`;
  }
  throw new UnsupportedTestShapeError(
    "toThrow over a non-create/op/validatable-VO expression is not runnable on vanilla",
  );
}

// ---------------------------------------------------------------------------
// Expression rendering
// ---------------------------------------------------------------------------

/** Render a test-position expression to Elixir, with money/decimal literals
 *  coerced to `Decimal` and aggregate `create`/op calls routed to the pure
 *  domain core. */
function vtExpr(e: ExprIR, env: Env): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "ref":
      // An enum value is the DECLARED-case atom (`:Public`) — matches the
      // `Ecto.Enum` field's loaded form for assertions AND casts cleanly when
      // passed in a create-attrs map.  Locals are snake names.  (Value names are
      // grammar identifiers, so the atom is never quoted — `:"Public"` would warn.)
      return e.refKind === "enum-value" ? `:${e.name}` : snake(e.name);
    case "member": {
      const recv = vtExpr(e.receiver, env);
      if (e.receiverType.kind === "array" && (e.member === "count" || e.member === "length")) {
        return `Enum.count(${recv})`;
      }
      if (
        e.receiverType.kind === "primitive" &&
        e.receiverType.name === "string" &&
        e.member === "length"
      ) {
        return `String.length(${recv})`;
      }
      return `${recv}.${snake(e.member)}`;
    }
    case "method-call": {
      if (isCreate(e)) return renderCreate(e, env);
      if (isAggOp(e, env)) return renderOp(e, env);
      throw new UnsupportedTestShapeError(
        `unsupported method-call '${e.member}' in vanilla test position`,
      );
    }
    case "call":
      // A value-object constructor builds a plain map on vanilla.
      if (e.callKind === "value-object-ctor") {
        const names = e.argNames ?? [];
        const fields = e.args
          .map((a, i) => `${snake(names[i] ?? `f${i}`)}: ${vtExpr(a, env)}`)
          .join(", ");
        return `%{${fields}}`;
      }
      if (e.callKind === "free") {
        return `${snake(e.name)}(${e.args.map((a) => vtExpr(a, env)).join(", ")})`;
      }
      throw new UnsupportedTestShapeError(
        `unsupported call kind '${e.callKind}' in vanilla test position`,
      );
    case "object":
    case "new":
      return `%{${e.fields.map((f) => `${snake(f.name)}: ${vtExpr(f.value, env)}`).join(", ")}}`;
    case "paren":
      return `(${vtExpr(e.inner, env)})`;
    case "unary": {
      if (e.op === "!") return `not ${vtExpr(e.operand, env)}`;
      // Fold a negative sign into a money/decimal literal — `-Decimal.new("1.0")`
      // is invalid (unary minus doesn't apply to a %Decimal{} struct).
      if (
        e.operand.kind === "literal" &&
        (e.operand.lit === "money" || e.operand.lit === "decimal")
      ) {
        return `Decimal.new(${JSON.stringify(`-${e.operand.value}`)})`;
      }
      return `-${vtExpr(e.operand, env)}`;
    }
    case "binary":
      return `${vtExpr(e.left, env)} ${binOp(e.op)} ${vtExpr(e.right, env)}`;
    default:
      throw new UnsupportedTestShapeError(
        `unsupported expression kind '${e.kind}' in vanilla test position`,
      );
  }
}

function renderLiteral(lit: string, value: string): string {
  switch (lit) {
    case "money":
    case "decimal":
      return `Decimal.new(${JSON.stringify(value)})`;
    case "string":
    case "datetime":
      return JSON.stringify(value);
    case "bool":
      return value;
    case "null":
      return "nil";
    default:
      // int / long — emit verbatim.
      return value;
  }
}

function binOp(op: string): string {
  switch (op) {
    case "&&":
      return "and";
    case "||":
      return "or";
    default:
      return op;
  }
}

/** `Agg.create(%{...})` over the create call's object-literal argument. */
function renderCreate(e: ExprIR, env: Env): string {
  if (e.kind !== "method-call") throw new Error("renderCreate: not a method-call");
  const arg = e.args[0];
  const attrs =
    arg && arg.kind === "object"
      ? `%{${arg.fields.map((f) => `${snake(f.name)}: ${vtExpr(f.value, env)}`).join(", ")}}`
      : "%{}";
  // `Agg.create(...)` — the receiver is the bare aggregate ref; honour its name.
  const mod =
    e.receiver.kind === "ref" ? `${env.ctxModule}.${upperFirst(e.receiver.name)}` : env.aggMod;
  return `${mod}.create(${attrs})`;
}

/** `Agg.<op>(recv, %{"param" => value, ...})` over the pure domain core. */
function renderOp(e: ExprIR, env: Env): string {
  if (e.kind !== "method-call") throw new Error("renderOp: not a method-call");
  const op = findOp(e.member, env);
  if (!op) throw new Error(`operation '${e.member}' not found on ${env.agg.name}`);
  const recv = vtExpr(e.receiver, env);
  const params = e.args
    .map((a, i) => `${JSON.stringify(op.params[i]?.name ?? `arg${i}`)} => ${vtExpr(a, env)}`)
    .join(", ");
  // A currentUser-gated op's pure-core fn carries a trailing `current_user`
  // (§11d); thread a synthetic privileged actor so the guard runs (parity with
  // node's test emitter).  Ungated ops are byte-identical.
  const actor = opUsesCurrentUser(op) ? `, ${TEST_ACTOR}` : "";
  return `${env.aggMod}.${snake(op.name)}(${recv}, %{${params}}${actor})`;
}

// ---------------------------------------------------------------------------
// Classification + helpers
// ---------------------------------------------------------------------------

function findOp(member: string, env: Env): OperationIR | undefined {
  return env.agg.operations.find((o) => o.name === member);
}

function isCreate(e: ExprIR): boolean {
  return e.kind === "method-call" && e.member === "create" && !e.isIntrinsicMatcher;
}

/** A call to one of the aggregate's declared operations.  Detected by NAME
 *  (receiver types are unreliable in test position); collection-ops and
 *  intrinsic matchers are excluded. */
function isAggOp(e: ExprIR, env: Env): boolean {
  return (
    e.kind === "method-call" &&
    !e.isCollectionOp &&
    !e.isIntrinsicMatcher &&
    e.member !== "create" &&
    findOp(e.member, env) !== undefined
  );
}

function isMoneyLike(inner: ExprIR, arg: ExprIR | undefined): boolean {
  const memberMoney =
    inner.kind === "member" &&
    inner.memberType.kind === "primitive" &&
    (inner.memberType.name === "money" || inner.memberType.name === "decimal");
  const argMoney = arg?.kind === "literal" && (arg.lit === "money" || arg.lit === "decimal");
  return Boolean(memberMoney || argMoney);
}

function usedRefNames(statements: readonly TestStmtIR[]): Set<string> {
  const used = new Set<string>();
  const collect = (e: ExprIR): void => {
    if (e.kind === "ref") used.add(e.name);
    for (const c of childExprs(e)) collect(c);
  };
  for (const s of statements) {
    for (const e of stmtExprs(s)) collect(e);
  }
  return used;
}

function stmtExprs(s: TestStmtIR): ExprIR[] {
  if (s.kind === "expect" || s.kind === "expect-throws" || s.kind === "let") return [s.expr];
  if (s.kind === "expression") return [s.expr];
  if (s.kind === "call") return s.args;
  return [];
}

function childExprs(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "member":
      return [e.receiver];
    case "method-call":
      return [e.receiver, ...e.args];
    case "call":
      return e.args;
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
    default:
      return [];
  }
}
