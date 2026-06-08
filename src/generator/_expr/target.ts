import type { ExprIR, LiteralKind } from "../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Shared ExprIR dispatch — the `ExprTarget` contract.
//
// Every domain-logic backend (TypeScript / .NET / Phoenix LiveView) renders
// the *same* fully-resolved Loom `ExprIR` to source.  The 17-arm `kind`
// dispatch and **all** recursion into sub-expressions are identical across
// backends — only the leaves diverge (operator spelling, name casing, money
// arithmetic, collection-op shape, `refColl.contains` membership, regex,
// `ref` role, `callKind` call syntax).
//
// `renderExprWith` owns the dispatch + recursion once; an `ExprTarget`
// supplies the per-backend leaves.  Sub-expressions are rendered here and
// handed to the target as already-rendered strings, so a target method is a
// pure leaf-formatter — it never recurses.  The few arms that branch on the
// raw node (member array-length, method-call membership/regex, binary money,
// callKind / refKind tables) also receive the original IR node.
//
// Mirrors the body-walker's `WalkerTarget` extraction (src/generator/_walker/
// target.ts).  Adding a backend = one target table, not a fourth dispatcher;
// adding an `ExprIR.kind` = one arm here + one method on the interface (the
// exhaustive switch makes both fail to type-check until done).
// ---------------------------------------------------------------------------

/** Minimum render context: every backend names the implicit receiver. */
export type ExprCtxBase = { thisName: string };

export type RefExpr = Extract<ExprIR, { kind: "ref" }>;
export type MemberExpr = Extract<ExprIR, { kind: "member" }>;
export type MethodCallExpr = Extract<ExprIR, { kind: "method-call" }>;
export type CallExpr = Extract<ExprIR, { kind: "call" }>;
export type LambdaExpr = Extract<ExprIR, { kind: "lambda" }>;
export type NewExpr = Extract<ExprIR, { kind: "new" }>;
export type ObjectExpr = Extract<ExprIR, { kind: "object" }>;
export type UnaryExpr = Extract<ExprIR, { kind: "unary" }>;
export type BinaryExpr = Extract<ExprIR, { kind: "binary" }>;
export type ConvertExpr = Extract<ExprIR, { kind: "convert" }>;

/** A `name: value` pair with `value` already rendered (object / new fields). */
export interface RenderedField {
  name: string;
  value: string;
}

/** A `cond -> value` match arm with both sides already rendered. */
export interface RenderedArm {
  cond: string;
  value: string;
}

/**
 * Per-backend leaf formatters for the 17 `ExprIR.kind` arms.  Sub-expressions
 * arrive already rendered; the raw node is passed only where a leaf branches
 * on it.  `paren` and `this` are not on the interface — they are byte-identical
 * across backends and handled directly in `renderExprWith`.
 */
export interface ExprTarget<Ctx extends ExprCtxBase> {
  literal(lit: LiteralKind, value: string): string;
  id(ctx: Ctx): string;
  ref(e: RefExpr, ctx: Ctx): string;
  member(recv: string, e: MemberExpr): string;
  methodCall(recv: string, args: string[], e: MethodCallExpr, ctx: Ctx): string;
  call(args: string[], e: CallExpr, ctx: Ctx): string;
  lambda(param: string, body: string | undefined): string;
  newPart(fields: RenderedField[], e: NewExpr, ctx: Ctx): string;
  object(fields: RenderedField[]): string;
  unary(op: UnaryExpr["op"], operand: string): string;
  binary(left: string, right: string, e: BinaryExpr): string;
  ternary(cond: string, then: string, otherwise: string): string;
  convert(value: string, e: ConvertExpr): string;
  match(arms: RenderedArm[], otherwise: string | undefined): string;
  list(elements: string[]): string;
}

/**
 * Dispatch a resolved `ExprIR` through a backend's `ExprTarget`.  Owns the
 * full 17-arm switch and all recursion; the exhaustive switch makes a new
 * `kind` a compile error until handled.
 */
export function renderExprWith<Ctx extends ExprCtxBase>(
  e: ExprIR,
  t: ExprTarget<Ctx>,
  ctx: Ctx,
): string {
  const r = (x: ExprIR): string => renderExprWith(x, t, ctx);
  switch (e.kind) {
    case "literal":
      return t.literal(e.lit, e.value);
    case "this":
      return ctx.thisName;
    case "id":
      return t.id(ctx);
    case "ref":
      return t.ref(e, ctx);
    case "member":
      return t.member(r(e.receiver), e);
    case "method-call":
      return t.methodCall(r(e.receiver), e.args.map(r), e, ctx);
    case "call":
      return t.call(e.args.map(r), e, ctx);
    case "lambda":
      return t.lambda(e.param, e.body ? r(e.body) : undefined);
    case "new":
      return t.newPart(
        e.fields.map((f) => ({ name: f.name, value: r(f.value) })),
        e,
        ctx,
      );
    case "object":
      return t.object(e.fields.map((f) => ({ name: f.name, value: r(f.value) })));
    case "paren":
      return `(${r(e.inner)})`;
    case "unary":
      return t.unary(e.op, r(e.operand));
    case "binary":
      return t.binary(r(e.left), r(e.right), e);
    case "ternary":
      return t.ternary(r(e.cond), r(e.then), r(e.otherwise));
    case "propagate":
      // `?` propagation is a statement-level early-return; its render lands in
      // a follow-up.  Surface-first, it's blocked before codegen by
      // `loom.propagate-unsupported` (exception-less.md A2), so this is dead.
      throw new Error("renderExprWith: '?' propagation is not emitted yet (exception-less.md A2).");
    case "convert":
      return t.convert(r(e.value), e);
    case "match":
      return t.match(
        e.arms.map((a) => ({ cond: r(a.cond), value: r(a.value) })),
        e.otherwise ? r(e.otherwise) : undefined,
      );
    case "list":
      return t.list(e.elements.map(r));
  }
}
