import { unionInstanceName, variantTag } from "../../ir/stdlib/unions.js";
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

/**
 * Minimum render context: every backend names the implicit receiver.
 *
 * `matchBindings` is the variant-`match` binding side-channel (variant-match.md):
 * while `renderExprWith` recurses into a variant arm's `value`, it maps each
 * in-scope binding name to the text that a `refKind: "match-binding"` ref to
 * that name must render as.  A native-pattern backend (.NET / Java / Elixir /
 * Python) sets the text to the binding identifier (it introduces a real bound
 * variable); the TS backend, which has no expression-level pattern binding,
 * sets it to the subject text (the binding is an *alias* of the scrutinee).
 * The `ref` leaf reads this map for a match-binding ref instead of formatting
 * the bare name.  Undefined / empty outside a variant arm.
 */
export type ExprCtxBase = { thisName: string; matchBindings?: ReadonlyMap<string, string> };

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

/** A boolean-form `cond -> value` match arm with both sides already rendered. */
export interface RenderedArm {
  cond: string;
  value: string;
}

/**
 * A variant-form match arm with its `value` already rendered (variant-match.md).
 * Each leaf formats its native discriminated-dispatch construct from these:
 *   - `tag` — the wire discriminator value (`variantTag(varType)`), e.g. the
 *     `subject.type === "<tag>"` comparand (TS) or the JSON `type` field.
 *   - `variantTypeName` — the variant's source-level type name (e.g. `Order`),
 *     for native pattern syntax (`Order o` / `%Order{}` / `case Order`).
 *   - `binding` — the bound variable name, or `undefined` if the arm bound
 *     none (`NotFound => x`).  Native backends emit a real binding; TS aliases
 *     it to the subject (see `ExprCtxBase.matchBindings`), so `binding` may be
 *     ignored by TS.
 *   - `value` — the already-rendered arm body (rendered with the binding's
 *     ref-text installed in `ctx.matchBindings`, so a reference to the binding
 *     came out correct for this backend).
 */
export interface RenderedVariantArm {
  tag: string;
  variantTypeName: string;
  binding: string | undefined;
  value: string;
}

/** All of a variant-`match`'s rendered pieces handed to `ExprTarget.matchVariant`. */
export interface RenderedVariantMatch {
  /** The already-rendered scrutinee (a simple ref/let read — side-effect-free). */
  subject: string;
  arms: RenderedVariantArm[];
  /** The rendered `else => …` catch-all, or `undefined` when absent. */
  otherwise: string | undefined;
  /** The union's instance name (`unionInstanceName(subjectType.variants)`),
   *  e.g. `AOrNF`.  Nominally-typed backends (Java/.NET) build a variant's
   *  concrete carrier type as `${unionName}_${tag}` for a native pattern
   *  (`case AOrNF_A a -> …`); structural/dynamic backends (TS/Python/Elixir)
   *  ignore it and dispatch on the `type` tag.  Empty when the subject type
   *  did not resolve to a union (a validator error path). */
  unionName: string;
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
  /** Render a `callKind: "domain-service"` member call
   *  (`Pricing.quote(cart, customer)` → the backend's call syntax for the
   *  generated domain-service module).  `serviceRef` is the resolved
   *  `{ service, op }`; `args` arrive already rendered.  Per-backend leaf —
   *  each backend's `call` switch delegates here (domain-services.md). */
  domainServiceCall(args: string[], serviceRef: { service: string; op: string }, ctx: Ctx): string;
  lambda(param: string, body: string | undefined): string;
  newPart(fields: RenderedField[], e: NewExpr, ctx: Ctx): string;
  object(fields: RenderedField[]): string;
  unary(op: UnaryExpr["op"], operand: string, e: UnaryExpr): string;
  binary(left: string, right: string, e: BinaryExpr): string;
  ternary(cond: string, then: string, otherwise: string): string;
  convert(value: string, e: ConvertExpr): string;
  /** Boolean predicate-arms `match { cond => value }` — the original form,
   *  unchanged.  Lowered to the backend's chained-conditional idiom. */
  match(arms: RenderedArm[], otherwise: string | undefined): string;
  /** Variant-`match SUBJECT { Type binding => value }` (variant-match.md) —
   *  the backend's native discriminated dispatch (TS discriminated-union
   *  conditional on `subject.type`; C#/Java `switch` expression; Elixir `case`;
   *  Python isinstance/match).  Arms arrive structured + pre-rendered so each
   *  leaf formats natively without re-resolving the variant set. */
  matchVariant(m: RenderedVariantMatch): string;
  /** The text a `refKind: "match-binding"` ref to `binding` renders as inside
   *  this arm's value.  Native-pattern backends return `binding` (a real bound
   *  variable); the TS backend returns `subject` (the binding is an alias of
   *  the scrutinee — TS has no expression-level pattern binding).  Called by
   *  `renderExprWith` to populate `ctx.matchBindings` before recursing. */
  bindingRefText(binding: string, subject: string): string;
  list(elements: string[]): string;
}

/** Source-level type name of a variant arm's `varType` — the comparand for a
 *  native pattern (`Order o`, `%Order{}`, `case Order`).  Named carriers
 *  (entity / value object / enum) expose their declared `name`; everything else
 *  falls back to the wire tag (the v1 variant set is named carriers in
 *  practice — see the `loom.match-unknown-variant` gate). */
function variantTypeName(a: Extract<ExprIR, { kind: "match" }>["variantArms"][number]): string {
  const t = a.varType;
  if (t.kind === "entity" || t.kind === "valueobject" || t.kind === "enum") return t.name;
  return variantTag(t);
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
      return t.unary(e.op, r(e.operand), e);
    case "binary":
      return t.binary(r(e.left), r(e.right), e);
    case "ternary":
      return t.ternary(r(e.cond), r(e.then), r(e.otherwise));
    case "convert":
      return t.convert(r(e.value), e);
    case "match": {
      // Variant form (variant-match.md) when a subject is present.
      if (e.subject) {
        const subject = r(e.subject);
        const arms = e.variantArms.map((a) => {
          // Install the binding side-channel before rendering this arm's
          // value, so a `refKind: "match-binding"` ref to `a.binding`
          // renders as the backend's binding text.  `bindingRefText`
          // lets a backend swap the alias (TS → subject) for the real
          // bound identifier (native backends → the binding name).
          const bindingText = a.binding ? t.bindingRefText(a.binding, subject) : undefined;
          const armCtx: Ctx =
            a.binding && bindingText !== undefined
              ? { ...ctx, matchBindings: new Map([[a.binding, bindingText]]) }
              : ctx;
          return {
            tag: variantTag(a.varType),
            variantTypeName: variantTypeName(a),
            binding: a.binding,
            value: renderExprWith(a.value, t, armCtx),
          };
        });
        return t.matchVariant({
          subject,
          arms,
          otherwise: e.otherwise ? r(e.otherwise) : undefined,
          unionName:
            e.subjectType?.kind === "union" ? unionInstanceName(e.subjectType.variants) : "",
        });
      }
      return t.match(
        e.arms.map((a) => ({ cond: r(a.cond), value: r(a.value) })),
        e.otherwise ? r(e.otherwise) : undefined,
      );
    }
    case "list":
      return t.list(e.elements.map(r));
    case "action-ref":
      // A named page/component action reference is a UI-handler-arg form
      // (named-actions-and-stores.md, Proposal A Stage 1).  It is consumed by
      // the JSX walker's call-site primitives, never by a domain-logic
      // expression renderer — reaching it here means it leaked to a domain
      // position, which the IR validator should already have rejected.
      throw new Error("renderExprWith: 'action-ref' is not a domain expression");
  }
}
