import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type DomainServiceIR,
  type ExprIR,
  operationUsesCurrentUser,
  type TestIR,
  type TestStmtIR,
  type TypeIR,
  type ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import { escapePythonIdent, snake } from "../../../util/naming.js";
import { renderPyExpr } from "../render-expr.js";

// A currentUser-gated operation's method signature picks up a trailing
// `current_user: User` parameter; a domain `test` block has no auth
// context, so calls to such ops are supplied a synthetic full-access
// actor — admin role + non-empty permissions so guards pass and the
// test exercises the op's domain logic.  Built on a SimpleNamespace +
// cast so it stays valid regardless of the system's actual
// `user { ... }` claim shape (the Python analogue of the TS emitter's
// `as unknown as User`).
const TEST_ACTOR_PY =
  'cast(User, SimpleNamespace(id="00000000-0000-0000-0000-000000000000", role="admin", permissions=["*"]))';

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → pytest file at `tests/test_<snake(agg)>.py`.
//
// Each test block becomes one `def test_<slug>() -> None:` function.
// Statement forms (the IR validator already restricted the body to the
// pure subset — see the TS emitter's notes):
//
//   expect(x).toBe(y)        → `assert x == y` (comparison matchers map
//                               1:1 onto operators; `.not.` inverts)
//   expect <bool-expr>       → `assert <bool-expr>`
//   expectThrows <call>      → `with pytest.raises(Exception): <call>`
//   let x = …                → `x = …`
//
// `<Agg>.create({ … })` literals coerce each field to its declared
// domain type the same way the TS emitter does: id strings brand via
// `<X>Id("…")`, value-object literals construct positionally in
// declared field order (omitted optionals → None), datetime literals
// parse via `datetime.fromisoformat`.
// ---------------------------------------------------------------------------

export function renderPyTestsFile(agg: AggregateIR, ctx: BoundedContextIR): string | null {
  return renderPySubjectTests(agg.name, agg.tests, ctx, {
    module: `app.domain.${snake(agg.name)}`,
    symbols: [agg.name, ...agg.parts.map((p) => p.name)],
  });
}

/** Value-object unit-test module (test-placement.md, Phase 2).  The VO is
 *  imported through the shared `app.domain.value_objects` narrowing — no
 *  dedicated subject import. */
export function renderPyVoTestsFile(vo: ValueObjectIR, ctx: BoundedContextIR): string | null {
  return renderPySubjectTests(vo.name, vo.tests, ctx, null);
}

/** Domain-service unit-test module (test-placement.md, Phase 2).  A service op
 *  renders as a bare module-level function (`snake(op)(…)`), so the test imports
 *  the referenced op functions from `app.domain.services.<snake(svc)>`. */
export function renderPyServiceTestsFile(
  svc: DomainServiceIR,
  ctx: BoundedContextIR,
): string | null {
  return renderPySubjectTests(svc.name, svc.tests, ctx, {
    module: `app.domain.services.${snake(svc.name)}`,
    symbols: svc.operations.map((o) => snake(o.name)),
  });
}

/** Shared pytest-module renderer for any subject.  `subjectImport` names the
 *  module + symbols carrying the subject's own code (an aggregate's per-agg
 *  module, a service's ops module); `null` for a value object, imported through
 *  the `app.domain.value_objects` narrowing.  Symbols are narrowed to names the
 *  body actually references. */
function renderPySubjectTests(
  describeName: string,
  tests: readonly TestIR[],
  ctx: BoundedContextIR,
  subjectImport: { module: string; symbols: string[] } | null,
): string | null {
  if (tests.length === 0) return null;

  const body: string[] = [];
  const usedNames = new Set<string>();
  for (const t of tests) {
    body.push("", "");
    body.push(...renderTest(t, ctx, usedNames));
  }
  const bodyStr = body.join("\n");

  const refs = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(bodyStr);
  const subjectNames = subjectImport ? subjectImport.symbols.filter(refs) : [];
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refs)
    .sort();
  // Every aggregate + part in the context yields an id class in
  // `app/domain/ids.py`.  A create-input `X id` field brands to `<X>Id(…)`,
  // and X may be a *cross-aggregate* reference (e.g. `customerId: Customer id`
  // on an Order test), so the candidate set is the whole context's ids, not
  // just this aggregate's own — filtered to those actually referenced.
  const idNames = [
    ...new Set(
      ctx.aggregates.flatMap((a) => [a.name, ...a.parts.map((p) => p.name)]).map((n) => `${n}Id`),
    ),
  ]
    .filter(refs)
    .sort();
  const usesPytest = /\bpytest\./.test(bodyStr);
  const usesDatetime = /\bdatetime\./.test(bodyStr);
  // A5 temporal — test bodies render domain expressions, so duration
  // constructors (`timedelta(...)`) can appear and need their imports.
  const usesTimedelta = /\btimedelta\(/.test(bodyStr);
  const usesDecimal = /\bDecimal\(/.test(bodyStr);
  const usesMath = /\bmath\./.test(bodyStr);
  const usesActor = bodyStr.includes("SimpleNamespace(");

  const out: string[] = [];
  out.push(`"""Domain tests for ${describeName}.  Auto-generated."""`);
  if (usesDatetime || usesTimedelta || usesDecimal || usesMath || usesPytest || usesActor) {
    out.push("");
  }
  if (usesMath) out.push("import math");
  if (usesDatetime || usesTimedelta) {
    const names = [
      ...(usesDatetime ? (/\bUTC\b/.test(bodyStr) ? ["UTC", "datetime"] : ["datetime"]) : []),
      ...(usesTimedelta ? ["timedelta"] : []),
    ];
    out.push(`from datetime import ${names.join(", ")}`);
  }
  if (usesDecimal) out.push("from decimal import Decimal");
  if (usesActor) out.push("from types import SimpleNamespace");
  if (usesActor) out.push("from typing import cast");
  if (usesPytest) out.push("import pytest");
  out.push("");
  if (usesActor) out.push("from app.auth.user import User");
  if (subjectImport && subjectNames.length > 0) {
    out.push(`from ${subjectImport.module} import ${subjectNames.join(", ")}`);
  }
  if (idNames.length > 0) {
    out.push(`from app.domain.ids import ${idNames.join(", ")}`);
  }
  if (voEnumNames.length > 0) {
    out.push(`from app.domain.value_objects import ${voEnumNames.join(", ")}`);
  }
  return `${out.join("\n")}\n${bodyStr}\n`;
}

/** A test name slug usable as a python identifier, deduped per file. */
function testFnName(name: string, used: Set<string>): string {
  const base =
    `test_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.replace(/_+$/, "") || "test_case";
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base}_${i++}`;
  used.add(candidate);
  return candidate;
}

function renderTest(t: TestIR, ctx: BoundedContextIR, used: Set<string>): string[] {
  const out: string[] = [];
  out.push(`def ${testFnName(t.name, used)}() -> None:`);
  // Track let-bound aggregate types: a bare `o.cancel()` expression
  // statement lowers with an untyped receiver, so gated-op detection
  // resolves the aggregate through the let's declared type instead.
  const lets = new Map<string, string>();
  for (const s of t.statements) {
    if (s.kind === "let" && s.type?.kind === "entity") lets.set(s.name, s.type.name);
  }
  const stmts = t.statements.flatMap((s) => renderTestStmt(s, ctx, lets));
  out.push(...(stmts.length > 0 ? stmts : ["    pass"]));
  return out;
}

/** Render a test-body expression: `<Agg>.create({ … })` object literals
 *  become coerced keyword arguments; everything else defers to
 *  `renderPyExpr`. */
function renderTestExpr(e: ExprIR, ctx: BoundedContextIR, lets?: Map<string, string>): string {
  // Calls of currentUser-gated ops thread the synthetic actor as the
  // trailing argument (mirrors the TS test emitter).  The aggregate
  // resolves through the receiver's type when lowered, else through the
  // let-binding table (bare expression statements lower untyped).
  if (e.kind === "method-call" && !e.isCollectionOp && !e.isIntrinsicMatcher) {
    const aggName =
      e.receiverType.kind === "entity"
        ? e.receiverType.name
        : e.receiver.kind === "ref"
          ? lets?.get(e.receiver.name)
          : undefined;
    const agg = aggName ? ctx.aggregates.find((a) => a.name === aggName) : undefined;
    const op = agg?.operations.find((o) => o.name === e.member);
    if (op && operationUsesCurrentUser(op)) {
      const recv = renderTestExpr(e.receiver, ctx, lets);
      const args = [...e.args.map((a) => renderTestExpr(a, ctx, lets)), TEST_ACTOR_PY];
      return `${recv}.${snake(e.member)}(${args.join(", ")})`;
    }
  }
  if (
    e.kind === "method-call" &&
    e.member === "create" &&
    e.receiver.kind === "ref" &&
    e.args.length === 1 &&
    e.args[0]!.kind === "object"
  ) {
    const agg = ctx.aggregates.find((a) => a.name === (e.receiver as { name: string }).name);
    if (agg) {
      return `${agg.name}.create(${renderCreateInput(e.args[0] as Extract<ExprIR, { kind: "object" }>, agg, ctx)})`;
    }
  }
  return renderPyExpr(e);
}

function renderCreateInput(
  obj: Extract<ExprIR, { kind: "object" }>,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const types = new Map(forCreateInput(agg.fields).map((f) => [f.name, f.type] as const));
  return obj.fields
    .map((f) => `${snake(f.name)}=${coerceCreateValue(f.value, types.get(f.name), ctx)}`)
    .join(", ");
}

/** Coerce one create-input value to its declared type for a domain test:
 *  `X id` string → `<X>Id("…")`, value-object literal → positional ctor
 *  in declared field order (omitted optionals → None), datetime literal
 *  → `datetime.fromisoformat("…")`. */
function coerceCreateValue(value: ExprIR, type: TypeIR | undefined, ctx: BoundedContextIR): string {
  if (type?.kind === "id") {
    return `${type.targetName}Id(${renderTestExpr(value, ctx)})`;
  }
  if (type?.kind === "valueobject" && value.kind === "object") {
    const vo = ctx.valueObjects.find((v) => v.name === type.name);
    if (vo) {
      const byName = new Map(value.fields.map((f) => [f.name, f.value] as const));
      const args = vo.fields.map((vf) => {
        const v = byName.get(vf.name);
        return v ? coerceCreateValue(v, vf.type, ctx) : "None";
      });
      return `${vo.name}(${args.join(", ")})`;
    }
  }
  if (
    type?.kind === "primitive" &&
    type.name === "datetime" &&
    value.kind === "literal" &&
    value.lit === "string"
  ) {
    return `datetime.fromisoformat(${renderTestExpr(value, ctx)})`;
  }
  return renderTestExpr(value, ctx);
}

/** Comparison matchers map 1:1 onto Python operators. */
const MATCHER_OP: Record<string, string> = {
  toBe: "==",
  toBeGreaterThan: ">",
  toBeGreaterThanOrEqual: ">=",
  toBeLessThan: "<",
  toBeLessThanOrEqual: "<=",
};

/** `expect(x).<matcher>(y)` / `.not.<matcher>(y)` → a comparison assert.
 *  Returns null for bare boolean assertions (caller wraps those). */
function renderExplicitMatcher(
  expr: ExprIR,
  ctx: BoundedContextIR,
  lets?: Map<string, string>,
): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const op = MATCHER_OP[expr.member];
  if (!op) return null;
  let receiver = expr.receiver;
  let negate = false;
  if (receiver.kind === "member" && receiver.member === "not") {
    negate = true;
    receiver = receiver.receiver;
  }
  const inner = receiver.kind === "paren" ? receiver.inner : receiver;
  const actual = renderTestExpr(inner, ctx, lets);
  const expected = expr.args.map((a) => renderTestExpr(a, ctx, lets)).join(", ");
  const cmp = `${actual} ${op} ${expected}`;
  return negate ? `    assert not (${cmp})` : `    assert ${cmp}`;
}

function renderTestStmt(
  s: TestStmtIR,
  ctx: BoundedContextIR,
  lets?: Map<string, string>,
): string[] {
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcher(s.expr, ctx, lets);
    if (explicit) return [explicit];
    return [`    assert ${renderTestExpr(s.expr, ctx, lets)}`];
  }
  if (s.kind === "expect-throws") {
    return ["    with pytest.raises(Exception):", `        ${renderTestExpr(s.expr, ctx, lets)}`];
  }
  if (s.kind === "let") {
    return [`    ${escapePythonIdent(snake(s.name))} = ${renderTestExpr(s.expr, ctx, lets)}`];
  }
  if (s.kind === "call") {
    const args = s.args.map((a) => renderTestExpr(a, ctx, lets)).join(", ");
    return [`    ${snake(s.name)}(${args})`];
  }
  if (s.kind === "expression") {
    return [`    ${renderTestExpr(s.expr, ctx, lets)}`];
  }
  // Mutating kinds are validator-rejected before they reach the
  // generator — same contract as the TS emitter.
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}
