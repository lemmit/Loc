import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type ContainmentIR,
  type DomainServiceIR,
  type ExprIR,
  operationUsesCurrentUser,
  type TestIR,
  type TestStmtIR,
  type TypeIR,
  type ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import { escapeTsIdent, lowerFirst } from "../../../util/naming.js";
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
//   expect(call).toThrow()  → vitest `expect(() => <call>).toThrow()`
//
// The container is a plain test file colocated next to the domain class;
// it imports the aggregate / parts / value objects directly.
// ---------------------------------------------------------------------------

/** Aggregate unit-test file — colocated next to the aggregate's domain class,
 *  importing `<Agg>`/parts from the per-aggregate module. */
export function renderTestsFile(agg: AggregateIR, ctx: BoundedContextIR): string | null {
  return renderTestsCore(agg.name, agg.tests, ctx, {
    symbols: [agg.name, ...agg.parts.map((p) => p.name)],
    modulePath: `./${lowerFirst(agg.name)}`,
  });
}

/** Value-object unit-test file (test-placement.md, Phase 2).  The VO is a
 *  member of `ctx.valueObjects`, so it's imported from `./value-objects` by the
 *  shared narrowing — no dedicated subject import needed. */
export function renderVoTestsFile(vo: ValueObjectIR, ctx: BoundedContextIR): string | null {
  return renderTestsCore(vo.name, vo.tests, ctx, null);
}

/** Domain-service unit-test file (test-placement.md, Phase 2).  The service is
 *  emitted as a namespace in `./services`. */
export function renderServiceTestsFile(svc: DomainServiceIR, ctx: BoundedContextIR): string | null {
  return renderTestsCore(svc.name, svc.tests, ctx, {
    symbols: [svc.name],
    modulePath: "./services",
  });
}

/** Shared unit-test-file renderer for any test subject.  `subjectImport` names
 *  the module + symbols that carry the subject's own code (an aggregate's
 *  per-agg module, a service's `./services`); it's `null` for a value object,
 *  which the `./value-objects` narrowing already imports.  Value-object / enum
 *  / `Ids` imports are narrowed to names the rendered body actually references,
 *  per the generated-code Biome gate. */
function renderTestsCore(
  describeName: string,
  tests: TestIR[],
  ctx: BoundedContextIR,
  subjectImport: { symbols: string[]; modulePath: string } | null,
): string | null {
  if (tests.length === 0) return null;
  // Render the describe body first so the import set can be narrowed to
  // names actually referenced (per the generated-code Biome gate).
  const body: string[] = [];
  body.push(`describe("${describeName}", () => {`);
  for (const t of tests) {
    body.push(...renderTest(t, ctx).map((l) => `  ${l}`));
    body.push("");
  }
  body.push(`});`);
  const bodyStr = body.join("\n");
  const refs = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(bodyStr);
  const subjectNames = subjectImport ? subjectImport.symbols.filter(refs) : [];
  const voNames = ctx.valueObjects.map((v) => v.name).filter(refs);
  const enumNames = ctx.enums.map((e) => e.name).filter(refs);
  const usesIds = /\bIds\.\w/.test(bodyStr);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { describe, it, expect } from "vitest";`);
  if (subjectImport && subjectNames.length > 0) {
    lines.push(`import { ${subjectNames.join(", ")} } from "${subjectImport.modulePath}";`);
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
/** True when a member read yields a nullable type on the generated domain
 *  object — so a further access on it needs a non-null assertion under strict
 *  `tsc`.  Two cases: an OPTIONAL field (`X?` → getter returns `T | null`), and
 *  a SINGLE (non-collection) containment (`contains x: X` → `T | null` on the
 *  domain object even when required, since it's unset at create and set later by
 *  an op).  A collection containment is a (non-null) array, so it's excluded. */
function isNullableMemberRead(e: ExprIR, ctx: BoundedContextIR): boolean {
  if (e.kind !== "member") return false;
  if (e.memberType.kind === "optional") return true;
  if (e.receiverType.kind === "entity") {
    const typeName = e.receiverType.name;
    const member = e.member;
    const owner: { contains?: readonly ContainmentIR[] } | undefined =
      ctx.aggregates.find((a) => a.name === typeName) ??
      ctx.aggregates.flatMap((a) => a.parts ?? []).find((p) => p.name === typeName);
    const c = owner?.contains?.find((x) => x.name === member);
    if (c && !c.collection) return true;
  }
  return false;
}

function renderTestExpr(e: ExprIR, ctx: BoundedContextIR): string {
  // A member read whose RECEIVER is a nullable field (single containment or
  // optional field, both `T | null` on the domain object) needs a non-null
  // assertion under strict `tsc`: `o.shipment.carrier` → `o.shipment!.carrier`.
  // The op that sets the containment ran earlier in the test, so the read is
  // sound — the assertion just tells the compiler what the author knows.  Only
  // the `!` is injected; everything else defers to the shared renderer.
  if (e.kind === "member" && isNullableMemberRead(e.receiver, ctx)) {
    return `${renderTestExpr(e.receiver, ctx)}!.${e.member}`;
  }
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
  // `<Agg>.create({ … })` — coerce each create-input field of the literal
  // object to its declared domain type, the same way the route handler does
  // when mapping a request body: a bare string in an `X id` position brands
  // to `Ids.XId(…)`, a bare object in a value-object position constructs
  // `new VO(…)`, a string in a datetime position to `new Date(…)`.  Without
  // this the user-written test literal (raw guid string, untyped object)
  // doesn't type-check against the create factory's branded input.  The
  // static receiver carries no entity instance type, so it's matched by the
  // bare aggregate-name ref rather than `receiverType`.
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
  return renderTsExpr(e);
}

/** Render a `create({ … })` input object with each field coerced to the
 *  aggregate's declared create-input type (see `renderTestExpr`).  Exported for
 *  the context-integration renderer (`integration-tests.ts`), which shares the
 *  same branded-create-input coercion. */
export function renderCreateInput(
  obj: Extract<ExprIR, { kind: "object" }>,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const types = new Map(forCreateInput(agg.fields).map((f) => [f.name, f.type] as const));
  const parts = obj.fields.map(
    (f) => `${f.name}: ${coerceCreateValue(f.value, types.get(f.name), ctx)}`,
  );
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/** Coerce one create-input value to its declared type for a domain test:
 *  `X id` string → `Ids.XId(…)`, value-object object literal → `new VO(…)`
 *  (declared field order, omitted optionals filled with `null`), datetime
 *  literal → `new Date(…)`.  Everything else renders unchanged. */
function coerceCreateValue(value: ExprIR, type: TypeIR | undefined, ctx: BoundedContextIR): string {
  if (type?.kind === "id") {
    return `Ids.${type.targetName}Id(${renderTestExpr(value, ctx)})`;
  }
  if (type?.kind === "valueobject" && value.kind === "object") {
    const vo = ctx.valueObjects.find((v) => v.name === type.name);
    if (vo) {
      const byName = new Map(value.fields.map((f) => [f.name, f.value] as const));
      const args = vo.fields.map((vf) => {
        const v = byName.get(vf.name);
        return v ? coerceCreateValue(v, vf.type, ctx) : "null";
      });
      return `new ${vo.name}(${args.join(", ")})`;
    }
  }
  if (type?.kind === "primitive" && type.name === "datetime" && value.kind === "literal") {
    return `new Date(${renderTestExpr(value, ctx)})`;
  }
  return renderTestExpr(value, ctx);
}

/** Detect `expect(x).<matcher>(y)` / `expect(x).not.<matcher>(y)` — an
 *  explicit intrinsic matcher call wrapped around an `expect` statement.
 *  Returns the vitest line directly (matcher names line up 1:1) so the
 *  inner expression isn't double-wrapped in `.toBe(true)`. Returns null
 *  for bare boolean assertions, which the caller still wraps.  Exported for the
 *  context-integration renderer, which shares the matcher mapping (its
 *  let-bound-find constraint keeps the actual expression await-free). */
export function renderExplicitMatcher(expr: ExprIR, ctx: BoundedContextIR): string | null {
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
    // Every `expect` carries a matcher (validator: checkExpectMatcher); a bare
    // boolean reaching codegen is an invariant violation, not user input.
    throw new Error("expect requires a matcher (e.g. expect(x).toBe(y)); got a bare expression.");
  }
  if (s.kind === "expect-throws") {
    return `  expect(() => { ${renderTestExpr(s.expr, ctx)}; }).toThrow();`;
  }
  if (s.kind === "let") {
    return `  const ${escapeTsIdent(s.name)} = ${renderTestExpr(s.expr, ctx)};`;
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
