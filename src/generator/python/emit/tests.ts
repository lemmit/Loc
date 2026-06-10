import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TestIR,
  TestStmtIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { snake } from "../../../util/naming.js";
import { renderPyExpr } from "../render-expr.js";

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
  if (agg.tests.length === 0) return null;

  const body: string[] = [];
  const usedNames = new Set<string>();
  for (const t of agg.tests) {
    body.push("", "");
    body.push(...renderTest(t, ctx, usedNames));
  }
  const bodyStr = body.join("\n");

  const refs = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(bodyStr);
  const domainNames = [agg.name, ...agg.parts.map((p) => p.name)].filter(refs);
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refs)
    .sort();
  const idNames = [agg.name, ...agg.parts.map((p) => p.name)]
    .map((n) => `${n}Id`)
    .filter(refs)
    .sort();
  const usesPytest = /\bpytest\./.test(bodyStr);
  const usesDatetime = /\bdatetime\./.test(bodyStr);
  const usesDecimal = /\bDecimal\(/.test(bodyStr);

  const out: string[] = [];
  out.push(`"""Domain tests for ${agg.name}.  Auto-generated."""`);
  if (usesDatetime || usesDecimal || usesPytest) out.push("");
  if (usesDatetime) out.push("from datetime import datetime");
  if (usesDecimal) out.push("from decimal import Decimal");
  if (usesPytest) out.push("import pytest");
  out.push("");
  if (domainNames.length > 0) {
    out.push(`from app.domain.${snake(agg.name)} import ${domainNames.join(", ")}`);
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
  const stmts = t.statements.flatMap((s) => renderTestStmt(s, ctx));
  out.push(...(stmts.length > 0 ? stmts : ["    pass"]));
  return out;
}

/** Render a test-body expression: `<Agg>.create({ … })` object literals
 *  become coerced keyword arguments; everything else defers to
 *  `renderPyExpr`. */
function renderTestExpr(e: ExprIR, ctx: BoundedContextIR): string {
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
  if (type?.kind === "primitive" && type.name === "datetime" && value.kind === "literal") {
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
function renderExplicitMatcher(expr: ExprIR, ctx: BoundedContextIR): string | null {
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
  const actual = renderTestExpr(inner, ctx);
  const expected = expr.args.map((a) => renderTestExpr(a, ctx)).join(", ");
  const cmp = `${actual} ${op} ${expected}`;
  return negate ? `    assert not (${cmp})` : `    assert ${cmp}`;
}

function renderTestStmt(s: TestStmtIR, ctx: BoundedContextIR): string[] {
  if (s.kind === "expect") {
    const explicit = renderExplicitMatcher(s.expr, ctx);
    if (explicit) return [explicit];
    return [`    assert ${renderTestExpr(s.expr, ctx)}`];
  }
  if (s.kind === "expect-throws") {
    return ["    with pytest.raises(Exception):", `        ${renderTestExpr(s.expr, ctx)}`];
  }
  if (s.kind === "let") {
    return [`    ${snake(s.name)} = ${renderTestExpr(s.expr, ctx)}`];
  }
  if (s.kind === "call") {
    const args = s.args.map((a) => renderTestExpr(a, ctx)).join(", ");
    return [`    ${snake(s.name)}(${args})`];
  }
  if (s.kind === "expression") {
    return [`    ${renderTestExpr(s.expr, ctx)}`];
  }
  // Mutating kinds are validator-rejected before they reach the
  // generator — same contract as the TS emitter.
  throw new Error(
    `internal: aggregate test body contains '${s.kind}' which the IR validator should have rejected`,
  );
}
