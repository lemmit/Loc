import type { AstNode } from "langium";
import { AstUtils } from "langium";
import type { PrimitiveName } from "../ir/types/loom-ir.js";
import { COLLECTION_OP_SIGNATURES, isCollectionOp } from "../util/collection-ops.js";
import { intrinsicFor, intrinsicReturnType, intrinsicsForReceiver } from "../util/intrinsics.js";
import { durationUnitOf } from "../util/temporal.js";
import type {
  Aggregate,
  BaseType,
  Criterion,
  EntityPart,
  EnumDecl,
  EventDecl,
  Expression,
  FunctionDecl,
  Lambda,
  MemberSuffix,
  Operation,
  Parameter,
  PayloadDecl,
  PolicyDecl,
  PostfixChain,
  PostfixSuffix,
  Property,
  Repository,
  TypeRef,
  ValueObject,
} from "./generated/ast.js";
import {
  isActionType,
  isAggregate,
  isApply,
  isBinaryChain,
  isBoolLit,
  isBoundedContext,
  isBuilderCall,
  isCallSuffix,
  isComponent,
  isContainment,
  isCriterion,
  isDecLit,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isEventDecl,
  isFindDecl,
  isFunctionDecl,
  isHandleDecl,
  isIdRef,
  isIdType,
  isIntLit,
  isLambda,
  isLetStmt,
  isMemberSuffix,
  isModel,
  isMoneyLit,
  isNamedType,
  isNameRef,
  isNowExpr,
  isNullLit,
  isOnDecl,
  isOperation,
  isPage,
  isParenExpr,
  isPayloadDecl,
  isPolicyDecl,
  isPostfixChain,
  isPrimitiveConversion,
  isPrimitiveType,
  isProperty,
  isSlotType,
  isStringLit,
  isSystem,
  isTemplateStr,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
  isWorkflow,
  isWorkflowCreateDecl,
} from "./generated/ast.js";
import { stdFunction } from "./stdlib.js";

// ---------------------------------------------------------------------------
// Type representation
// ---------------------------------------------------------------------------

/** Information-flow sensitivity labels carried by a value's type.  An
 * empty / absent tag set means "clean".  Tags are opaque identifiers
 * declared at field sites via `sensitive(<tag>, ...)`; the type system
 * propagates them through expression composition (concat, ternary,
 * call returns) so a value can't be laundered clean by reshaping the
 * expression.  See `docs/old/proposals/sensitivity-and-compliance.md`. */
export type SensitivityTags = readonly string[];

export type DddType =
  | { kind: "primitive"; name: PrimitiveName; sensitivity?: SensitivityTags }
  | { kind: "id"; target: Aggregate | EntityPart; sensitivity?: SensitivityTags }
  | { kind: "enum"; ref: EnumDecl; sensitivity?: SensitivityTags }
  | { kind: "valueobject"; ref: ValueObject; sensitivity?: SensitivityTags }
  | { kind: "aggregate"; ref: Aggregate; sensitivity?: SensitivityTags }
  | { kind: "entity"; ref: EntityPart; sensitivity?: SensitivityTags }
  /** A transport record — an `event` (EventDecl) or a `payload`
   *  (`command`/`query`/`response`/`error`).  Carried by a workflow command
   *  parameter (`create(e: PaymentReceived) by …`, `handle h(c: SettleOrder)`)
   *  and by `on`/`apply` event bindings.  A flat record of `fields` (no `id`,
   *  containment, or derived members); member access resolves through
   *  `stepInto`'s payload arm so field-level type checks (comparison /
   *  arithmetic / assignment) apply instead of cascading to `unknown`. */
  | { kind: "payload"; ref: EventDecl | PayloadDecl; sensitivity?: SensitivityTags }
  | { kind: "array"; element: DddType; sensitivity?: SensitivityTags }
  | { kind: "optional"; inner: DddType; sensitivity?: SensitivityTags }
  /** Element-shaped param marker — mirrors the `TypeIR.slot` variant
   *  produced by lowering a `SlotType` AST node.  Only valid on a
   *  `component`'s parameter list (the validator
   *  `checkSlotTypePosition` rejects misuse).  Conceptually equivalent
   *  to `React.ReactNode`; arithmetic / comparison / member access on
   *  a slot ref is an error and the consumer-side validators flag it.
   *  Compatibility against `any` succeeds (opaque pass-through). */
  | { kind: "slot"; sensitivity?: SensitivityTags }
  /** Function-valued param marker — `slot`'s behavioural sibling
   *  (extern-component-escape-hatch.md, Tier 2).  Only valid on a
   *  `component`'s parameter list (`checkActionTypePosition` rejects
   *  misuse).  `arg` is the callback's declared argument type
   *  (undefined for a bare zero-arg `action`); the caller-side value
   *  is a lambda whose param types flow forward from `arg`. */
  | { kind: "action"; arg?: DddType; sensitivity?: SensitivityTags }
  | { kind: "any"; sensitivity?: SensitivityTags }
  | { kind: "never"; sensitivity?: SensitivityTags }
  | { kind: "unknown"; sensitivity?: SensitivityTags };

// `PrimitiveName` is the canonical primitive-type set sourced from
// `src/ir/types/loom-ir.ts` (the IR layer downstream consumes the same
// union the type-system layer assigns names against — kept in one
// place so a new primitive shows up in both without N parallel
// updates).  See `experience_gathered.md` → "Adding a new primitive".
export type { PrimitiveName };

export const T = {
  prim: (name: PrimitiveName): DddType => ({ kind: "primitive", name }),
  array: (e: DddType): DddType => ({ kind: "array", element: e }),
  opt: (i: DddType): DddType => ({ kind: "optional", inner: i }),
  slot: { kind: "slot" } as DddType,
  any: { kind: "any" } as DddType,
  never: { kind: "never" } as DddType,
  unknown: { kind: "unknown" } as DddType,
};

// ---------------------------------------------------------------------------
// Sensitivity helpers — union, subset, attach.  Tag sets are stored as
// sorted, deduplicated readonly arrays so equality is cheap and the IR
// (which mirrors `SensitivityTags`) stays JSON-serializable.
// ---------------------------------------------------------------------------

/** Merge any number of tag sets into a single canonical (sorted, unique)
 * tag set.  Returns undefined when every input is empty so the "clean"
 * case stays represented as the absent field rather than an empty array
 * — keeps existing equality / JSON output unchanged for non-sensitive types. */
export function mergeTags(
  ...sets: ReadonlyArray<SensitivityTags | undefined>
): SensitivityTags | undefined {
  const seen = new Set<string>();
  for (const s of sets) {
    if (!s) continue;
    for (const t of s) seen.add(t);
  }
  if (seen.size === 0) return undefined;
  return Object.freeze([...seen].sort()) as SensitivityTags;
}

/** True iff every tag in `sub` is present in `sup` (treating undefined /
 * empty as the empty set).  The narrowing direction we forbid in
 * `isAssignable`: a value with tags can't flow into a slot with fewer
 * tags. */
export function tagsSubset(
  sub: SensitivityTags | undefined,
  sup: SensitivityTags | undefined,
): boolean {
  if (!sub || sub.length === 0) return true;
  if (!sup || sup.length === 0) return false;
  for (const t of sub) if (!sup.includes(t)) return false;
  return true;
}

/** Attach (union) tags to a type.  Returns the input unchanged when the
 * tag set is empty — keeps the common "clean" path allocation-free. */
export function withTags(t: DddType, tags: SensitivityTags | undefined): DddType {
  if (!tags || tags.length === 0) return t;
  const merged = mergeTags(t.sensitivity, tags);
  return { ...t, sensitivity: merged };
}

/** Pull the tags declared at a Property's declaration site (if any). */
export function propertySensitivity(p: Property | undefined): SensitivityTags | undefined {
  const tags = p?.sensitivity?.tags;
  if (!tags || tags.length === 0) return undefined;
  return Object.freeze([...new Set(tags)].sort()) as SensitivityTags;
}

export function typeToString(t: DddType): string {
  const base = (() => {
    switch (t.kind) {
      case "primitive":
        return t.name;
      case "id":
        return `${t.target.name} id`;
      case "enum":
        return t.ref.name;
      case "valueobject":
        return t.ref.name;
      case "aggregate":
        return t.ref.name;
      case "entity":
        return t.ref.name;
      case "payload":
        return t.ref.name;
      case "array":
        return `${typeToString(t.element)}[]`;
      case "optional":
        return `${typeToString(t.inner)}?`;
      case "slot":
        return "slot";
      case "action":
        return t.arg ? `action(${typeToString(t.arg)})` : "action";
      case "any":
        return "any";
      case "never":
        return "never";
      case "unknown":
        return "unknown";
    }
  })();
  if (t.sensitivity && t.sensitivity.length > 0) {
    return `${base}!{${t.sensitivity.join(",")}}`;
  }
  return base;
}

export function typesEqual(a: DddType, b: DddType): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind !== b.kind) return false;
  // Structural equality only — sensitivity is a *flow* property layered
  // by `isAssignable`, not part of structural identity.  Keeping this
  // function tag-agnostic preserves the semantics every existing caller
  // (validator, LSP) relies on.
  switch (a.kind) {
    case "primitive":
      return a.name === (b as typeof a).name;
    case "id":
      return a.target === (b as typeof a).target;
    case "enum":
      return a.ref === (b as typeof a).ref;
    case "valueobject":
      return a.ref === (b as typeof a).ref;
    case "aggregate":
      return a.ref === (b as typeof a).ref;
    case "entity":
      return a.ref === (b as typeof a).ref;
    case "payload":
      return a.ref === (b as typeof a).ref;
    case "array":
      return typesEqual(a.element, (b as typeof a).element);
    case "optional":
      return typesEqual(a.inner, (b as typeof a).inner);
    default:
      return true;
  }
}

// `null` literal is assignable to any optional type; numeric widening
// (int → long, int → decimal) is permitted.  Sensitivity narrowing
// (`string!{pii}` → `string!{}`) is allowed structurally but flagged by
// `sensitivityNarrows`; the validator emits a warning at the call site
// so an implicit conversion that drops tags is visible without
// breaking the build.
export function isAssignable(value: DddType, target: DddType): boolean {
  if (typesEqual(value, target)) return true;
  if (value.kind === "any" || target.kind === "any") return true;
  if (target.kind === "optional") {
    // `never` (the `null` literal) and any bare `T` that fits the inner
    // type wrap into the optional.  An optional VALUE only fits when its
    // OWN inner type is assignable to the target's inner — this is what
    // keeps `int? := string?` an error while still admitting numeric
    // widening through the optional (`int? → long?` composes with the
    // primitive-widening arm below via the recursive inner check).  A
    // `never`-typed inner is the bottom type (the `null` literal types as
    // `never?` — see the `isNullLit` arm of `typeOf`), so `never? → U?`
    // stays assignable regardless of `U`.
    return (
      value.kind === "never" ||
      isAssignable(value, target.inner) ||
      (value.kind === "optional" &&
        (value.inner.kind === "never" || isAssignable(value.inner, target.inner)))
    );
  }
  if (value.kind === "primitive" && target.kind === "primitive") {
    if (value.name === "int" && (target.name === "long" || target.name === "decimal")) return true;
    if (value.name === "long" && target.name === "decimal") return true;
  }
  return false;
}

/**
 * True iff `a` and `b` are pairwise comparable with the relational /
 * equality operators (`== != < <= > >=`).  Comparable pairs:
 *
 *   - same primitive (`string == string`, `bool != bool`)
 *   - both numeric in the `int / long / decimal` widening chain
 *     (`int < decimal`) — money is intentionally NOT mixed in here;
 *     it's a closed type, only comparable with money
 *   - both money
 *   - same enum (different enums have no shared values; rejected)
 *   - same `X id` target (different aggregate ids reject)
 *   - same value object (different VOs reject)
 *   - `T?` compared with `T` (optional unwrap), `null` against any
 *     `T?` (null literal narrows to `never`-typed optional)
 *
 * Mixing across these categories yields meaningless comparisons:
 * `string == int` is always false in JS / always-error in C# /
 * runtime-crash in Elixir; the validator should reject up front
 * rather than waiting for backends to surface it inconsistently.
 *
 * Used by the binary-operand validator and by future LSP code
 * actions (e.g. "did you mean `<other>.id == X` instead of
 * `<other> == X`?").
 */
export function comparable(a: DddType, b: DddType): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind === "never" || b.kind === "never") return true; // null literal
  if (typesEqual(a, b)) return true;
  if (a.kind === "primitive" && b.kind === "primitive") {
    const numeric = (n: PrimitiveName) => n === "int" || n === "long" || n === "decimal";
    if (numeric(a.name) && numeric(b.name)) return true;
  }
  if (a.kind === "optional") return comparable(a.inner, b);
  if (b.kind === "optional") return comparable(a, b.inner);
  return false;
}

/**
 * Join of a ternary's two branch types (`cond ? a : b`) — the value the
 * whole expression produces.  Uses the existing `isAssignable` lattice
 * (numeric widening `int → long → decimal`, optional-wrapping `T → T?`,
 * `never`/`null` as the bottom type) rather than inventing a new one:
 *
 *   - if one branch is assignable to the other, the target (the more
 *     general side) is the join — `cond ? int : long` ⇒ `long`,
 *     `cond ? T : T?` ⇒ `T?`;
 *   - the `null` literal (`never?` / `never`) joins with any `T` into
 *     `T?` — `cond ? null : order` ⇒ `Order?`;
 *   - otherwise the branches share no supertype (`cond ? int : string`)
 *     and the join is `undefined` — the ternary validator reports it.
 *
 * Sensitivity is NOT merged here (a structural join); callers attach the
 * union of both branches' tags with `withTags` so a value chosen from
 * either branch stays as tainted as either was.
 */
export function ternaryJoin(a: DddType, b: DddType): DddType | undefined {
  if (a.kind === "unknown" || b.kind === "unknown") return T.unknown;
  if (isAssignable(a, b)) return b;
  if (isAssignable(b, a)) return a;
  // The `null` literal types as `never?` (see the `isNullLit` arm of
  // `typeOf`); a bare `never` is the same bottom.  Either joins with a
  // non-optional branch by wrapping it into an optional.
  const isNullish = (t: DddType): boolean =>
    t.kind === "never" || (t.kind === "optional" && t.inner.kind === "never");
  if (isNullish(a)) return b.kind === "optional" ? b : T.opt(b);
  if (isNullish(b)) return a.kind === "optional" ? a : T.opt(a);
  return undefined;
}

/** True iff `value` carries sensitivity tags that `target` does not.
 * The validator uses this to emit a warning at flow boundaries
 * (assignments, emits, derived expressions, function returns) where
 * a sensitive value silently flows into a non-sensitive — or
 * less-sensitive — target.  Implicit conversion is *permitted* at the
 * type level; the warning makes the conversion visible.
 *
 * Returns the dropped tag set when narrowing occurs, undefined when
 * it does not — callers can include the dropped tags in the diagnostic. */
export function sensitivityNarrows(value: DddType, target: DddType): SensitivityTags | undefined {
  if (tagsSubset(value.sensitivity, target.sensitivity)) return undefined;
  const dropped: string[] = [];
  for (const t of value.sensitivity ?? []) {
    if (!target.sensitivity?.includes(t)) dropped.push(t);
  }
  if (dropped.length === 0) return undefined;
  return Object.freeze(dropped.sort()) as SensitivityTags;
}

// ---------------------------------------------------------------------------
// TypeRef → DddType
// ---------------------------------------------------------------------------

export function resolveTypeRef(ref: TypeRef | undefined): DddType {
  if (!ref?.base) return T.unknown;
  let resolved = resolveBase(ref.base);
  if (ref.array) resolved = T.array(resolved);
  if (ref.optional) resolved = T.opt(resolved);
  return resolved;
}

function resolveBase(base: BaseType): DddType {
  if (isPrimitiveType(base)) return T.prim(base.name as PrimitiveName);
  if (isSlotType(base)) return T.slot;
  if (isActionType(base)) {
    return base.arg ? { kind: "action", arg: resolveTypeRef(base.arg) } : { kind: "action" };
  }
  if (isIdType(base)) {
    const target = base.target?.ref;
    if (!target) return T.unknown;
    if (isAggregate(target) || isEntityPart(target)) {
      return { kind: "id", target };
    }
    return T.unknown;
  }
  if (isNamedType(base)) {
    const target = base.target?.ref;
    if (!target) return T.unknown;
    if (isEnumDecl(target)) return { kind: "enum", ref: target };
    if (isValueObject(target)) return { kind: "valueobject", ref: target };
    if (isAggregate(target)) return { kind: "aggregate", ref: target };
    if (isEntityPart(target)) return { kind: "entity", ref: target };
    if (isEventDecl(target) || isPayloadDecl(target)) return { kind: "payload", ref: target };
    return T.unknown;
  }
  return T.unknown;
}

// ---------------------------------------------------------------------------
// Expression typing
// ---------------------------------------------------------------------------

/**
 * Lookup environment for an expression: maps identifiers to their declared
 * type and the AST node that introduced them.  Used both for type-checking
 * and for symbol resolution in generators.
 */
export interface Env {
  resolve(name: string): { type: DddType; origin: AstNode } | undefined;
  // The aggregate (root) currently in scope, if any — needed to type `id`
  // and lookup nested parts/functions/operations.
  aggregate?: Aggregate;
  // The entity part currently in scope, if any (a part declares its own
  // `id` of type PartName id).
  part?: EntityPart;
  // The value object currently in scope, if any.
  valueObject?: ValueObject;
}

export function typeOf(expr: Expression | undefined, env: Env): DddType {
  if (!expr) return T.unknown;
  if (isStringLit(expr)) return T.prim("string");
  // A6 string interpolation — a template always types as `string`; its holes
  // are checked separately by `checkTemplateHoles` (`loom.interp-hole-type`).
  if (isTemplateStr(expr)) return T.prim("string");
  if (isIntLit(expr)) return T.prim("int");
  if (isDecLit(expr)) return T.prim("decimal");
  if (isMoneyLit(expr)) return T.prim("money");
  if (isPrimitiveConversion(expr)) return T.prim(expr.target as PrimitiveName);
  if (isBoolLit(expr)) return T.prim("bool");
  if (isNullLit(expr)) return T.opt(T.never);
  if (isNowExpr(expr)) return T.prim("datetime");
  if (isThisRef(expr)) {
    if (env.part) return { kind: "entity", ref: env.part };
    if (env.aggregate) return { kind: "aggregate", ref: env.aggregate };
    if (env.valueObject) return { kind: "valueobject", ref: env.valueObject };
    return T.unknown;
  }
  if (isIdRef(expr)) {
    if (env.part) return { kind: "id", target: env.part };
    if (env.aggregate) return { kind: "id", target: env.aggregate };
    return T.unknown;
  }
  if (isParenExpr(expr)) return typeOf(expr.inner, env);
  if (isUnaryExpr(expr)) {
    const t = typeOf(expr.operand, env);
    // `!x` is a fresh bool — comparison-class result, no propagation.
    if (expr.op === "!") return T.prim("bool");
    return t;
  }
  if (isBinaryChain(expr)) {
    // Left-fold: comparison / logical ops produce bool (short-circuit
    // the chain — the chain is homogeneous-op per precedence level, so
    // a single bool-result op makes the entire chain bool).
    let acc = typeOf(expr.head, env);
    for (let i = 0; i < expr.ops.length; i++) {
      const op = expr.ops[i]!;
      if (op === "&&" || op === "||") return T.prim("bool");
      if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
        return T.prim("bool");
      }
      const rt = typeOf(expr.rest[i]!, env);
      acc = arithmeticResult(acc, rt, op);
    }
    return acc;
  }
  if (isTernaryExpr(expr)) {
    // The value is the JOIN of the two branches (the more general of the
    // two) — `cond ? int : long` is `long`, `cond ? T : null` is `T?`.
    // When the branches share no supertype the join falls back to the
    // then-branch (the validator reports the mismatch separately).
    // Sensitivity is unioned either way — the chosen value could come from
    // either branch, so the result is as tainted as either branch is.
    const thenT = typeOf(expr.thenExpr, env);
    const elseT = typeOf(expr.elseExpr, env);
    const join = ternaryJoin(thenT, elseT) ?? thenT;
    return withTags(join, mergeTags(thenT.sensitivity, elseT.sensitivity));
  }
  if (isLambda(expr)) {
    // Lambda type is contextual; without a target type it's unknown.
    return T.unknown;
  }
  if (isBuilderCall(expr)) {
    return typeOfBuilderCall(expr, env);
  }
  if (isPostfixChain(expr)) {
    return typeOfPostfixChain(expr, env);
  }
  if (isNameRef(expr)) {
    const looked = env.resolve(expr.name);
    if (looked) return looked.type;
    // A bare reference to a parameterless criterion / policy function is a
    // boolean predicate.
    if (lookupCriterionByName(expr.name, env)) return T.prim("bool");
    if (lookupPolicyFnByName(expr.name, env)) return T.prim("bool");
    return T.unknown;
  }
  return T.unknown;
}

export function arithmeticResult(a: DddType, b: DddType, op: string): DddType {
  // Sensitivity flows through any arithmetic or string concatenation.
  // `"Hello " + email` ⇒ string!{pii}; `(price + tax)` inherits whatever
  // tags either operand carries.
  const tags = mergeTags(a.sensitivity, b.sensitivity);

  // String concatenation: `+` between a string and an "implicitly
  // stringifiable" operand (numeric primitive, bool, enum, or `X id`)
  // produces a string, with the non-string side auto-converted at
  // the lowering layer (mirrors how every modern `+`-for-concat
  // language behaves).  Checked before the money/numeric paths so
  // `"hello" + money(...)` and `"id: " + orderId` succeed instead
  // of falling into the wrong branch.  The convert-injection lives
  // in `lower-expr.ts`'s binary handler — same `convert` IR shape
  // explicit `string(x)` produces, so backends emit identically.
  if (op === "+") {
    const aStr = a.kind === "primitive" && a.name === "string";
    const bStr = b.kind === "primitive" && b.name === "string";
    if (aStr || bStr) {
      const other = aStr ? b : a;
      if (aStr && bStr) return withTags(T.prim("string"), tags);
      if (isImplicitlyStringifiable(other)) return withTags(T.prim("string"), tags);
      // Fall through — `"hello" + customer` (a VO) hits unknown,
      // surfaced by the validator with a "no canonical string form"
      // diagnostic.  Same for datetime / guid until each gets its
      // own explicit form (datetime needs format choices, guid is
      // rare).
    }
  }

  // money is a closed type with restricted arithmetic.  Checked before
  // the general numeric-widening path so a stray decimal in a money
  // expression is rejected instead of silently widening through
  // `int → long → decimal`.  Rules:
  //   money ± money              → money
  //   money × {int|long|decimal} → money   (also commutative)
  //   money ÷ {int|long|decimal} → money
  //   anything else involving money → unknown (rejected)
  const aIsMoney = a.kind === "primitive" && a.name === "money";
  const bIsMoney = b.kind === "primitive" && b.name === "money";
  if (aIsMoney || bIsMoney) {
    return withTags(moneyArithmetic(a, b, op, aIsMoney, bIsMoney), tags);
  }

  // duration / datetime form a closed temporal algebra (A5 temporal) —
  // checked before the numeric-widening path (like money) so a stray
  // operand is rejected instead of silently widening.  Rules in
  // `temporalArithmetic` below.
  const isTemporal = (t: DddType): boolean =>
    t.kind === "primitive" && (t.name === "duration" || t.name === "datetime");
  if (isTemporal(a) || isTemporal(b)) {
    return withTags(temporalArithmetic(a, b, op), tags);
  }

  if (a.kind === "primitive" && b.kind === "primitive") {
    const order = ["int", "long", "decimal"] as const;
    const ai = (order as readonly string[]).indexOf(a.name);
    const bi = (order as readonly string[]).indexOf(b.name);
    if (ai >= 0 && bi >= 0) {
      const widened = order[Math.max(ai, bi)]!;
      // Division always yields a fractional result: `int / int` (and
      // `long / long`, `int / long`) widens to `decimal`, so `5 / 2` is `2.5`
      // on every backend rather than truncating differently per host.  An
      // author who wants truncating integer division writes `a.divTrunc(b)`.
      // `+ - * %` stay int-preserving; money/decimal handled above.
      if (op === "/" && (widened === "int" || widened === "long")) {
        return withTags(T.prim("decimal"), tags);
      }
      return withTags(T.prim(widened), tags);
    }
  }
  return withTags(T.unknown, tags);
}

/**
 * The closed temporal arithmetic rules (A5 temporal, docs/old/plans/stdlib.md)
 * — the duration/datetime twin of `moneyArithmetic`.  At least one operand
 * is duration- or datetime-typed when this runs.  Rules:
 *
 *   datetime + duration → datetime      duration + datetime → datetime
 *   datetime - duration → datetime      datetime - datetime → duration
 *   duration ± duration → duration
 *   duration × int → duration           int × duration → duration
 *
 * Everything else involving a duration/datetime operand under `+ - * / %`
 * is rejected (unknown) — including `duration ÷ anything`, `datetime ×`,
 * and mixing with non-int numerics (a fractional day is written as
 * `hours(n)`, not `days(0.5)`).
 */
function temporalArithmetic(a: DddType, b: DddType, op: string): DddType {
  const an = a.kind === "primitive" ? a.name : undefined;
  const bn = b.kind === "primitive" ? b.name : undefined;
  if (an === "datetime" && bn === "duration") {
    return op === "+" || op === "-" ? T.prim("datetime") : T.unknown;
  }
  if (an === "duration" && bn === "datetime") {
    return op === "+" ? T.prim("datetime") : T.unknown;
  }
  if (an === "datetime" && bn === "datetime") {
    return op === "-" ? T.prim("duration") : T.unknown;
  }
  if (an === "duration" && bn === "duration") {
    return op === "+" || op === "-" ? T.prim("duration") : T.unknown;
  }
  if (op === "*" && ((an === "duration" && bn === "int") || (an === "int" && bn === "duration"))) {
    return T.prim("duration");
  }
  return T.unknown;
}

/**
 * Whether a type can be implicitly stringified in `string + X` arithmetic.
 * Yes for:
 *   - numeric primitives (int / long / decimal / money) — universally
 *     stringified in every backend
 *   - bool — `"true"` / `"false"`
 *   - enum — host enum-to-name conversion (`OrderStatus.Confirmed.toString()`
 *     etc.)
 *   - `X id` — wraps a primitive, ID's underlying form is its string
 *     representation
 * No for everything else — value objects, aggregates, entities,
 * arrays, datetime (format ambiguity), guid (rarely concatenated;
 * explicit `string(x)` once admitted).  Same set the explicit
 * `string(x)` conversion vocabulary admits.
 */
export function isImplicitlyStringifiable(t: DddType): boolean {
  if (t.kind === "primitive") {
    return (
      t.name === "int" ||
      t.name === "long" ||
      t.name === "decimal" ||
      t.name === "money" ||
      t.name === "bool"
    );
  }
  if (t.kind === "enum") return true;
  if (t.kind === "id") return true;
  if (t.kind === "aggregate") return aggregateHasDisplay(t.ref);
  return false;
}

/** True iff the aggregate declares a `derived display: string = ...`.
 * Anchors `string(aggregate)` and implicit `"x " + aggregate` to a
 * concrete expression; absence makes both compile errors. */
function aggregateHasDisplay(agg: Aggregate): boolean {
  return agg.members.some((m) => isDerivedProp(m) && m.name === "display");
}

function moneyArithmetic(
  a: DddType,
  b: DddType,
  op: string,
  aIsMoney: boolean,
  bIsMoney: boolean,
): DddType {
  if (aIsMoney && bIsMoney) {
    // money ± money = money; money × money / money ÷ money rejected.
    return op === "+" || op === "-" ? T.prim("money") : T.unknown;
  }
  // Exactly one operand is money.  The other must be a numeric scalar
  // (int / long / decimal) for scaling; anything else is rejected.
  const other = aIsMoney ? b : a;
  if (other.kind !== "primitive") return T.unknown;
  const isScalar = other.name === "int" || other.name === "long" || other.name === "decimal";
  if (!isScalar) return T.unknown;
  // money × scalar (commutative) = money;
  // money ÷ scalar = money (but scalar ÷ money is rejected).
  if (op === "*") return T.prim("money");
  if (op === "/" && aIsMoney) return T.prim("money");
  return T.unknown;
}

/** Type of a PostfixChain — walk head + suffixes, threading the type
 *  through each step.  Each MemberSuffix dispatches to the same
 *  member-typing rules typeOfMemberAccess used; each CallSuffix
 *  resolves the receiver via the head-name lookup (matches typeOfCall). */
function typeOfPostfixChain(expr: PostfixChain, env: Env): DddType {
  // Head + first suffix: a CallSuffix at the front collapses
  // `<NameRef>(args)` to the function / VO ctor lookup (legacy
  // CallExpr typing).  Anything else starts from the head's type.
  let curType: DddType;
  const first = expr.suffixes[0];
  if (first && isCallSuffix(first) && isNameRef(expr.head)) {
    curType = typeOfFreeCall(expr.head.name, env);
    for (let i = 1; i < expr.suffixes.length; i++) {
      curType = typeAfterSuffix(curType, expr.suffixes[i]!, env);
    }
    return curType;
  }
  curType = typeOf(expr.head, env);
  for (const s of expr.suffixes) {
    curType = typeAfterSuffix(curType, s, env);
  }
  return curType;
}

function typeOfFreeCall(name: string, env: Env): DddType {
  const sym = env.resolve(name);
  if (sym && isFunctionDecl(sym.origin)) {
    return resolveTypeRef(sym.origin.returnType);
  }
  if (sym && isValueObject(sym.origin)) {
    return { kind: "valueobject", ref: sym.origin };
  }
  const fn = lookupFunctionInScope(name, env);
  if (fn) return resolveTypeRef(fn.returnType);
  const vo = lookupValueObjectByName(name, env);
  if (vo) return { kind: "valueobject", ref: vo };
  // A parameterised criterion call (`InRegion("EU")`) or policy-function call
  // (`CanApprove(cap)`) is a boolean predicate.
  if (lookupCriterionByName(name, env)) return T.prim("bool");
  if (lookupPolicyFnByName(name, env)) return T.prim("bool");
  // Top-level (ambient) helper function (stdlib Phase B) — its declared
  // return type.  After the shadowing lookups above, before the duration
  // builtins (a user `function days(...)` shadows the `days()` builtin).
  const topFn = lookupTopLevelFunction(name, env);
  if (topFn) return resolveTypeRef(topFn.returnType);
  // A5 duration constructors (`days(n)` / `hours(n)` / `minutes(n)`) —
  // builtins only when no user declaration matched above (a user
  // `function days(...)` shadows the builtin).  Arity / argument type are
  // the validator's job (`loom.duration-arity`), not typing's.
  if (durationUnitOf(name)) return T.prim("duration");
  return T.unknown;
}

/** The user `FunctionDecl` a free call `name(args)` resolves to, or `undefined`
 *  when the call targets anything else — a value-object constructor, a criterion,
 *  a policy function, a duration builtin, or an unresolved name.  Mirrors
 *  `typeOfFreeCall`'s resolution ORDER exactly (same lookups, same shadowing) so
 *  the arg-count/type validator and the type system can never disagree about
 *  what a free call targets.  The validator uses this to arg-check ONLY the
 *  unambiguous user-function case, leaving criteria / policy-fns / duration
 *  builtins to their own gates. */
export function freeCallFunction(name: string, env: Env): FunctionDecl | undefined {
  const sym = env.resolve(name);
  if (sym && isFunctionDecl(sym.origin)) return sym.origin;
  if (sym && isValueObject(sym.origin)) return undefined; // VO constructor, not a function
  const fn = lookupFunctionInScope(name, env);
  if (fn) return fn;
  if (lookupValueObjectByName(name, env)) return undefined; // VO shadows a top-level fn
  if (lookupCriterionByName(name, env)) return undefined;
  if (lookupPolicyFnByName(name, env)) return undefined;
  const topFn = lookupTopLevelFunction(name, env);
  if (topFn) return topFn;
  return undefined; // duration builtin / unresolved — not the call-arg validator's concern
}

/** The parameter list of the criterion / policy-function a free call `name(args)`
 *  targets, or `undefined` when it targets neither.  Mirrors `typeOfFreeCall`'s
 *  order for the predicate arms (after function / value-object resolution, which
 *  shadow a predicate).  Consumed by the arg-TYPE validator: a criterion / policy
 *  call already has its ARITY checked model-wide (`loom.criterion-arity` /
 *  `checkPolicyFns`), so the validator only type-checks the args this resolves. */
export function freeCallPredicate(name: string, env: Env): Parameter[] | undefined {
  // A function or value object shadows a predicate of the same name — the caller
  // only reaches here when `freeCallFunction` already returned undefined, so
  // guard the value-object case (functions are already excluded).
  const sym = env.resolve(name);
  if (sym && isValueObject(sym.origin)) return undefined;
  if (lookupValueObjectByName(name, env)) return undefined;
  const crit = lookupCriterionByName(name, env);
  if (crit) return crit.params;
  const pol = lookupPolicyFnByName(name, env);
  if (pol) return pol.params;
  return undefined;
}

/**
 * True iff a free call to `name` is an A5 duration-constructor BUILTIN in
 * `env` — i.e. `name` is one of `days`/`hours`/`minutes` AND no
 * user declaration (function / value object / criterion) shadows it.
 * Mirrors `typeOfFreeCall`'s lookup order exactly; exported for the
 * temporal validator (`checkDurationConstructors`), so the validator and
 * the type system can never disagree about what is a builtin.
 */
export function isDurationBuiltinCall(name: string, env: Env): boolean {
  if (!durationUnitOf(name)) return false;
  const sym = env.resolve(name);
  if (sym && (isFunctionDecl(sym.origin) || isValueObject(sym.origin))) return false;
  if (lookupFunctionInScope(name, env)) return false;
  if (lookupTopLevelFunction(name, env)) return false;
  if (lookupValueObjectByName(name, env)) return false;
  if (lookupCriterionByName(name, env)) return false;
  return true;
}

export function typeAfterSuffix(recvType: DddType, suffix: PostfixSuffix, env: Env): DddType {
  if (isCallSuffix(suffix)) {
    // Invoking a non-NameRef receiver — without a signature the
    // result is unknown (matches the legacy CallExpr typing for a
    // non-NameRef callee).
    return T.unknown;
  }
  const ms = suffix as MemberSuffix;
  const memberName = ms.member;
  // Collection ops on arrays.
  if (recvType.kind === "array") {
    return collectionOpType(recvType, memberName, ms, env);
  }
  if (recvType.kind === "entity" || recvType.kind === "aggregate") {
    return lookupEntityMember(recvType.ref, memberName);
  }
  if (recvType.kind === "valueobject") {
    return lookupValueObjectMember(recvType.ref, memberName);
  }
  if (recvType.kind === "payload") {
    return lookupPayloadMember(recvType.ref, memberName);
  }
  if (recvType.kind === "primitive" && recvType.name === "string") {
    if (memberName === "length") return T.prim("int");
    if (memberName === "matches" && ms.call) return T.prim("bool");
  }
  if (recvType.kind === "primitive" && ms.call) {
    // Scalar intrinsics (src/util/intrinsics.ts) — catalogue-driven, so a
    // new op types here (and completes, via membersOfType) without code.
    const sig = intrinsicFor(recvType.name, memberName);
    if (sig) {
      const ret = intrinsicReturnType(sig, recvType.name);
      if (ret.endsWith("[]")) return T.array(T.prim(ret.slice(0, -2) as PrimitiveName));
      return T.prim(ret as PrimitiveName);
    }
  }
  if (recvType.kind === "id") {
    return lookupEntityMember(recvType.target, memberName);
  }
  return T.unknown;
}

function lookupEntityMember(target: Aggregate | EntityPart, name: string): DddType {
  if (name === "id") {
    return { kind: "id", target };
  }
  for (const m of target.members) {
    if (isProperty(m) && m.name === name)
      return withTags(resolveTypeRef(m.type), propertySensitivity(m));
    if (isContainment(m) && m.name === name) {
      const part = m.partType?.ref;
      if (!part) return T.unknown;
      const t: DddType = { kind: "entity", ref: part };
      return m.collection ? T.array(t) : t;
    }
    if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
    if (isFunctionDecl(m) && m.name === name) {
      // Function reference — without call this is unknown (we treat it as
      // an unevaluated function symbol).
      return T.unknown;
    }
  }
  return T.unknown;
}

function lookupValueObjectMember(target: ValueObject, name: string): DddType {
  for (const m of target.members) {
    if (isProperty(m) && m.name === name)
      return withTags(resolveTypeRef(m.type), propertySensitivity(m));
    if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
  }
  return T.unknown;
}

/** Member type on a transport record (`event` / `payload`) — a flat list of
 *  `Property` fields, no `id` / containment / derived.  Resolving the field
 *  type lets the binary-operand / comparison / assignment validators check
 *  expressions over event/payload param fields instead of cascading to
 *  `unknown`. */
function lookupPayloadMember(target: EventDecl | PayloadDecl, name: string): DddType {
  for (const f of target.fields) {
    if (f.name === name) return withTags(resolveTypeRef(f.type), propertySensitivity(f));
  }
  return T.unknown;
}

/** For the unknown-member validator: when `recvType` is a record we can
 *  fully enumerate (aggregate / entity / value object / event-or-payload, or
 *  an `X id` resolving to one) and `name` is **not** one of its members,
 *  returns the record's display name (for the diagnostic).  Returns
 *  `undefined` when the member exists *or* the receiver isn't a fully
 *  enumerable record (array, primitive, slot, enum, `any`, `unknown`, or a
 *  nested optional) — i.e. it fails open and never reports on uncertainty.
 *
 *  Membership is a name match across *any* declared member (property,
 *  containment, derived, function, operation), not the type-returning
 *  lookups: those map a function/operation member to `T.unknown` (no useful
 *  type without a call), which is indistinguishable from "absent" and would
 *  flag a legitimate `this.someOperation()`.  `id` is always valid on an
 *  aggregate / entity / id receiver (the implicit identity accessor). */
export function absentRecordMember(recvType: DddType, name: string): string | undefined {
  // Member access transparently unwraps a single optional level.
  const t = recvType.kind === "optional" ? recvType.inner : recvType;
  switch (t.kind) {
    case "aggregate": {
      if (name === "id") return undefined;
      return aggregateChainHasMember(t.ref, name) ? undefined : t.ref.name;
    }
    case "entity": {
      // Entity parts don't participate in `extends` inheritance (aggregate-only).
      if (name === "id") return undefined;
      const has = t.ref.members.some((m) => (m as { name?: string }).name === name);
      return has ? undefined : t.ref.name;
    }
    case "id": {
      if (name === "id") return undefined;
      const tgt = t.target;
      const has = isAggregate(tgt)
        ? aggregateChainHasMember(tgt, name)
        : tgt.members.some((m) => (m as { name?: string }).name === name);
      return has ? undefined : tgt.name;
    }
    case "valueobject": {
      const has = t.ref.members.some((m) => (m as { name?: string }).name === name);
      return has ? undefined : t.ref.name;
    }
    case "payload": {
      const has = t.ref.fields.some((f) => f.name === name);
      return has ? undefined : t.ref.name;
    }
    default:
      return undefined;
  }
}

/** True iff `name` is declared anywhere in an aggregate's `extends` chain.
 *  A concrete aggregate inherits the abstract base's fields / operations, so
 *  the membership check (`absentRecordMember`) must walk `superType` — without
 *  it, `this.<inheritedField>` on a subtype is a false positive.  The local
 *  `seen` set below guards against an infinite loop on a malformed `extends`
 *  cycle; the cycle itself is reported separately as `loom.extends-cycle` by
 *  the inheritance validator (`validators/inheritance.ts`, Rule 1b). */
function aggregateChainHasMember(agg: Aggregate, name: string): boolean {
  const seen = new Set<Aggregate>();
  let cur: Aggregate | undefined = agg;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur.members.some((m) => (m as { name?: string }).name === name)) return true;
    cur = cur.superType?.ref;
  }
  return false;
}

// Collection-op catalogue moved to src/util/collection-ops.ts (pure data
// catalogue, consumed by ir/, generator/, system/ as well — keeps the
// language layer free of back-edges).

function collectionOpType(
  recv: { kind: "array"; element: DddType },
  name: string,
  ms: MemberSuffix,
  env: Env,
): DddType {
  switch (name) {
    case "count":
      return T.prim("int");
    case "sum": {
      // sum returns the lambda's body type when one is given;
      // otherwise the element type itself.  Args are CallArg
      // wrappers — peek through `.value`.
      const callArg = ms.args[0];
      const lambdaArg = callArg?.value;
      if (lambdaArg && isLambda(lambdaArg) && lambdaArg.body) {
        const lambdaEnv = makeEnv(
          env,
          new Map([[lambdaArg.param, { type: recv.element, origin: lambdaArg }]]),
        );
        return typeOf(lambdaArg.body, lambdaEnv);
      }
      return recv.element;
    }
    case "all":
    case "any":
    case "contains":
      return T.prim("bool");
    case "map": {
      // map returns an array of the lambda's body type — mirrors `sum`'s
      // lambda-body typing, then wraps in an array.  Without a lambda arg
      // fall back to an array of the element type (the identity projection).
      const callArg = ms.args[0];
      const lambdaArg = callArg?.value;
      if (lambdaArg && isLambda(lambdaArg) && lambdaArg.body) {
        const lambdaEnv = makeEnv(
          env,
          new Map([[lambdaArg.param, { type: recv.element, origin: lambdaArg }]]),
        );
        return T.array(typeOf(lambdaArg.body, lambdaEnv));
      }
      return T.array(recv.element);
    }
    case "sortBy":
    case "distinct":
    case "take":
    case "skip":
      return T.array(recv.element);
    case "where":
      return T.array(recv.element);
    case "join":
      return T.prim("string");
    case "first":
      return recv.element;
    case "firstOrNull":
      return T.opt(recv.element);
    case "min":
    case "max": {
      // min/max project the collection through the lambda and return the
      // PROJECTED value, optional (empty collection → null).  Mirrors `sum`'s
      // lambda-env typing; falls back to an optional element type with no lambda.
      const callArg = ms.args[0];
      const lambdaArg = callArg?.value;
      if (lambdaArg && isLambda(lambdaArg) && lambdaArg.body) {
        const lambdaEnv = makeEnv(
          env,
          new Map([[lambdaArg.param, { type: recv.element, origin: lambdaArg }]]),
        );
        return T.opt(typeOf(lambdaArg.body, lambdaEnv));
      }
      return T.opt(recv.element);
    }
    case "avg": {
      // avg projects the collection through the lambda and returns the MEAN,
      // optional (empty collection → null).  A money projection averages to
      // `money?`; every other numeric projection (int/long/decimal) to
      // `decimal?`.  Mirrors `sum`'s lambda-env typing.
      const callArg = ms.args[0];
      const lambdaArg = callArg?.value;
      if (lambdaArg && isLambda(lambdaArg) && lambdaArg.body) {
        const lambdaEnv = makeEnv(
          env,
          new Map([[lambdaArg.param, { type: recv.element, origin: lambdaArg }]]),
        );
        const bodyT = typeOf(lambdaArg.body, lambdaEnv);
        const isMoney = bodyT.kind === "primitive" && bodyT.name === "money";
        return T.opt(T.prim(isMoney ? "money" : "decimal"));
      }
      const isMoney = recv.element.kind === "primitive" && recv.element.name === "money";
      return T.opt(T.prim(isMoney ? "money" : "decimal"));
    }
    default:
      return T.unknown;
  }
}

function lookupFunctionInScope(
  name: string,
  env: Env,
): import("./generated/ast.js").FunctionDecl | undefined {
  const scopes: Array<Aggregate | EntityPart | ValueObject | undefined> = [
    env.part,
    env.aggregate,
    env.valueObject,
  ];
  for (const s of scopes) {
    if (!s) continue;
    for (const m of s.members) {
      if (isFunctionDecl(m) && m.name === name) return m;
    }
  }
  return undefined;
}

/** A TOP-LEVEL (ambient) helper `function` named `name` (stdlib Phase B) —
 *  declared at file root or inside a `system { }`, visible workspace-wide.
 *  Checked AFTER local functions / VO ctors / criteria / policy fns (which
 *  shadow it), mirroring the lowerer's inline precedence (`inlineTopLevelFn`
 *  only fires when `resolveCallKind` is `"free"`). */
function lookupTopLevelFunction(
  name: string,
  env: Env,
): import("./generated/ast.js").FunctionDecl | undefined {
  const anchor = env.aggregate ?? env.part ?? env.valueObject;
  if (anchor) {
    const model = AstUtils.getContainerOfType(anchor, isModel);
    if (model) {
      for (const m of model.members) {
        if (isFunctionDecl(m) && m.name === name) return m;
        if (isSystem(m)) {
          for (const sm of m.members) if (isFunctionDecl(sm) && sm.name === name) return sm;
        }
      }
    }
  }
  // Ambient std prelude (stdlib Phase C) — after any user-declared top-level
  // function (which shadows it), so a call to a prelude function types to its
  // declared return.
  return stdFunction(name);
}

/** v2 BuilderCall typing.  The type name resolves against the enclosing
 *  bounded context (value objects + aggregates + parts).  Unknown names
 *  type as `unknown` — the validator surfaces the diagnostic. */
function typeOfBuilderCall(expr: import("./generated/ast.js").BuilderCall, env: Env): DddType {
  const name = expr.type;
  const vo = lookupValueObjectByName(name, env);
  if (vo) return { kind: "valueobject", ref: vo };
  const ent = lookupEntityByName(name, env);
  if (ent) {
    return ent.$type === "Aggregate"
      ? { kind: "aggregate", ref: ent }
      : { kind: "entity", ref: ent };
  }
  return T.unknown;
}

function lookupEntityByName(name: string, env: Env): Aggregate | EntityPart | undefined {
  const start = env.aggregate ?? env.part ?? env.valueObject;
  if (!start) return undefined;
  const ctx = AstUtils.getContainerOfType(start, isBoundedContext);
  if (!ctx) return undefined;
  for (const m of ctx.members) {
    if (isAggregate(m)) {
      if (m.name === name) return m;
      for (const inner of m.members) {
        if (isEntityPart(inner) && inner.name === name) return inner;
      }
    }
  }
  return undefined;
}

/** Resolve a criterion by name against the enclosing bounded context.
 *  Criteria are context-level predicate specifications (see
 *  docs/criterion.md); a reference to one in expression position types
 *  as `bool`. */
function lookupCriterionByName(name: string, env: Env): Criterion | undefined {
  const start = env.aggregate ?? env.part ?? env.valueObject;
  if (!start) return undefined;
  const ctx = AstUtils.getContainerOfType(start, isBoundedContext);
  if (!ctx) return undefined;
  for (const m of ctx.members) {
    if (isCriterion(m) && m.name === name) return m;
  }
  return undefined;
}

/** Resolve a FUNCTION-form `policy` declaration by name against the enclosing
 *  bounded context (auth P3.2).  A reference to one in expression position
 *  (e.g. a `requires PolicyName(args)` gate) types as `bool`.  Only the
 *  function form (carrying a `returnType`) is callable; a block-form
 *  `policy {}` read ladder is not. */
function lookupPolicyFnByName(name: string, env: Env): PolicyDecl | undefined {
  const start = env.aggregate ?? env.part ?? env.valueObject;
  if (!start) return undefined;
  const ctx = AstUtils.getContainerOfType(start, isBoundedContext);
  if (!ctx) return undefined;
  for (const m of ctx.members) {
    if (isPolicyDecl(m) && m.returnType !== undefined && m.name === name) return m;
  }
  return undefined;
}

function lookupValueObjectByName(name: string, env: Env): ValueObject | undefined {
  // Walk up to bounded context and search value objects.  `members` on
  // BoundedContext is `ContextMember[]` in the generated AST — we use
  // the typed `isValueObject` guard to narrow rather than escape-hatch
  // casting through `unknown`.
  const start = env.aggregate ?? env.part ?? env.valueObject;
  if (!start) return undefined;
  const ctx = AstUtils.getContainerOfType(start, isBoundedContext);
  if (!ctx) return undefined;
  for (const m of ctx.members) {
    if (isValueObject(m) && m.name === name) return m;
  }
  return undefined;
}

// Matcher catalogue + isCollectionOp moved to src/util/intrinsic-matchers.ts
// and src/util/collection-ops.ts — pure data catalogues that all layers
// can import without back-edges into language/.

export function lambdaTakesElementOf(t: DddType): DddType {
  if (t.kind === "array") return t.element;
  return T.unknown;
}

// ---------------------------------------------------------------------------
// Pure-expression check for `function` bodies
// ---------------------------------------------------------------------------

export function isPureExpression(_expr: Expression): boolean {
  // Expressions are inherently pure in this DSL — they cannot mutate or
  // emit.  Purity violations live in statements (`:=`, `+=`, `-=`, `emit`),
  // which can never appear inside a `function` body because the grammar
  // only accepts an Expression there.
  return true;
}

// ---------------------------------------------------------------------------
// Helpers for collecting parameters / let-bindings into an Env
// ---------------------------------------------------------------------------

export function paramType(p: Parameter): DddType {
  return resolveTypeRef(p.type);
}

export type SymbolOrigin =
  | Parameter
  | { letBinding: import("./generated/ast.js").LetStmt }
  | FunctionDecl
  | Operation
  | ValueObject
  | EntityPart
  | Aggregate
  | EnumDecl
  | { lambdaParam: Lambda };

export function makeEnv(
  outer: Env | undefined,
  bindings: Map<string, { type: DddType; origin: AstNode }>,
  ctx: { aggregate?: Aggregate; part?: EntityPart; valueObject?: ValueObject } = {},
): Env {
  return {
    aggregate: ctx.aggregate ?? outer?.aggregate,
    part: ctx.part ?? outer?.part,
    valueObject: ctx.valueObject ?? outer?.valueObject,
    resolve(name) {
      const found = bindings.get(name);
      if (found) return found;
      return outer?.resolve(name);
    },
  };
}

// Re-entrancy guard for let-type inference.  Computing a let's initializer
// type can, for an exotic initializer (a collection-op lambda whose element
// type resolves via `envForNode`), recurse back into `envForNode` for a node
// inside the SAME body — which re-enters this inference.  The guard bounds a
// self- / mutual-cycle to `T.unknown` for the let currently in flight so the
// walk always terminates.
const lettingInFlight = new Set<import("./generated/ast.js").LetStmt>();

/**
 * Bind each `let` in `stmts` to the type of its initializer, threaded
 * sequentially through `bindings` so a later let — and every downstream
 * operand check that reads these bindings via `envForNode` — sees the
 * precise types of the params, members, and earlier lets already bound.
 * Mutates `bindings` in place.
 *
 * This computes the SAME type `checkStatement` (validators/statements.ts)
 * derives when it threads an operation body, unifying the two env builders:
 * previously `envForNode` bound every let to `T.unknown`, which silently
 * disengaged every operand check on a `let` operand (`let s = "hi"
 * requires s > 5` produced no diagnostic because `s` typed as `unknown`).
 */
function addTypedLets(
  bindings: Map<string, { type: DddType; origin: AstNode }>,
  stmts: import("./generated/ast.js").Statement[],
  ctx: { aggregate?: Aggregate; part?: EntityPart; valueObject?: ValueObject },
): void {
  // `env` reads `bindings` live (makeEnv closes over the map by reference),
  // so each let is typed against everything bound so far — params, members,
  // and the lets that lexically precede it.
  const env = makeEnv(undefined, bindings, ctx);
  for (const s of stmts) {
    if (!isLetStmt(s)) continue;
    let t: DddType = T.unknown;
    if (!lettingInFlight.has(s)) {
      lettingInFlight.add(s);
      try {
        t = typeOf(s.expr, env);
      } finally {
        lettingInFlight.delete(s);
      }
    }
    bindings.set(s.name, { type: t, origin: s });
  }
}

// ---------------------------------------------------------------------------
// AST-walk helpers used by the validator and other consumers.  Imports
// for Aggregate / FunctionDecl / Operation already exist at the top of
// this file.
// ---------------------------------------------------------------------------

/** Resolve a bare identifier as an aggregate root member (or `id`). */
export function lookupRootMember(agg: Aggregate, name: string): DddType {
  if (name === "id") return { kind: "id", target: agg };
  for (const m of agg.members) {
    if (isProperty(m) && m.name === name)
      return withTags(resolveTypeRef(m.type), propertySensitivity(m));
    if (isContainment(m) && m.name === name) {
      const part = m.partType?.ref;
      if (!part) return T.unknown;
      const t: DddType = { kind: "entity", ref: part };
      return m.collection ? T.array(t) : t;
    }
    if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
  }
  return T.unknown;
}

/** Walk a single dotted path step on a typed receiver. */
export function stepInto(t: DddType, name: string): DddType {
  if (t.kind === "entity" || t.kind === "aggregate") {
    if (name === "id") return { kind: "id", target: t.ref };
    for (const m of t.ref.members) {
      if (isProperty(m) && m.name === name)
        return withTags(resolveTypeRef(m.type), propertySensitivity(m));
      if (isContainment(m) && m.name === name) {
        const part = m.partType?.ref;
        if (!part) return T.unknown;
        const inner: DddType = { kind: "entity", ref: part };
        return m.collection ? T.array(inner) : inner;
      }
      if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
    }
  }
  if (t.kind === "valueobject") {
    for (const m of t.ref.members) {
      if (isProperty(m) && m.name === name)
        return withTags(resolveTypeRef(m.type), propertySensitivity(m));
      if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
    }
  }
  if (t.kind === "payload") {
    // A transport record is a flat list of `Property` fields — no `id`,
    // containment, or derived members.  Resolving the field type (instead of
    // cascading to `unknown`) is what lets the binary-operand / assignment
    // validators check expressions over event/payload param fields.
    for (const f of t.ref.fields) {
      if (f.name === name) return withTags(resolveTypeRef(f.type), propertySensitivity(f));
    }
  }
  return T.unknown;
}

export function findFunction(agg: Aggregate, name: string): FunctionDecl | undefined {
  for (const m of agg.members) {
    if (isFunctionDecl(m) && m.name === name) return m;
  }
  return undefined;
}

export function findOperation(agg: Aggregate, name: string): Operation | undefined {
  for (const m of agg.members) {
    if (isOperation(m) && m.name === name) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// envForNode — builds a `typeOf`-ready Env for any node in the AST.
//
// Walks up to the closest scope-bearing container (operation, function,
// invariant, derived prop, value object, part, aggregate) and assembles
// bindings + scope context.  The validator constructs equivalent envs
// inline; LSP services (hover, completion) need the same data without
// having to recreate the walk per provider.
//
// Bindings come from (in increasing precedence):
//   1. Aggregate / part / value-object members (as bare names).
//   2. Function or operation parameters.
//   3. `let` bindings from preceding statements in the enclosing block.
//
// `let` bindings are typed `T.unknown` for simplicity — the validator
// already does this; the precise type would require running `typeOf`
// at the bind site, which is awkward in a one-pass env builder.
// ---------------------------------------------------------------------------

export function envForNode(node: AstNode): Env {
  const part = AstUtils.getContainerOfType(node, isEntityPart);
  const vo = AstUtils.getContainerOfType(node, isValueObject);
  const fn = AstUtils.getContainerOfType(node, isFunctionDecl);
  const op = AstUtils.getContainerOfType(node, isOperation);
  const find = AstUtils.getContainerOfType(node, isFindDecl);
  const _wf = AstUtils.getContainerOfType(node, isWorkflow);
  // UI-side containers — pages and components carry typed params
  // (route-params for pages, slot/aggregate-typed for components) that
  // need to flow through `typeOf` so the binary-operand validator and
  // LSP can reason about expressions inside their bodies.
  const page = AstUtils.getContainerOfType(node, isPage);
  const component = AstUtils.getContainerOfType(node, isComponent);

  // The `this`/root aggregate: an enclosing aggregate container, else the
  // repository's `for` aggregate (find filters) — reached through a
  // cross-reference, not containment.  Workflows orchestrate across aggregates
  // and have no `this`.
  const agg =
    AstUtils.getContainerOfType(node, isAggregate) ??
    (find ? (find.$container as Repository | undefined)?.aggregate?.ref : undefined);

  const bindings = new Map<string, { type: DddType; origin: AstNode }>();

  // 1. Member bindings — innermost wins, so build outer→inner.
  if (agg && !part) addEntityMembers(agg.members, bindings);
  if (part) addEntityMembers(part.members, bindings);
  if (vo) {
    for (const m of vo.members) {
      if (isProperty(m))
        bindings.set(m.name, {
          type: withTags(resolveTypeRef(m.type), propertySensitivity(m)),
          origin: m,
        });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    }
  }

  // 2. Function / operation / find / workflow / page / component
  //    parameter bindings.  Page + component params come last so a
  //    nested component's param can shadow an outer ui-scope name —
  //    today no such nesting exists, but the order matches the lexical
  //    expectation if it ever does.
  // A2-S5f: a workflow body is members-only — params + statements live inside
  // the enclosing `create`/`handle` member, not on the workflow.
  const create = AstUtils.getContainerOfType(node, isWorkflowCreateDecl);
  const handle = AstUtils.getContainerOfType(node, isHandleDecl);
  const params =
    fn?.params ??
    op?.params ??
    find?.params ??
    create?.params ??
    handle?.params ??
    component?.params ??
    page?.params ??
    [];
  for (const p of params) bindings.set(p.name, { type: paramType(p), origin: p });

  // 3. let-bindings from the enclosing executable body (operation / workflow
  //    create / handle / on reactor).  Typed sequentially against the members
  //    + params already bound (so a let sees earlier lets / params) — the
  //    same type `checkStatement` computes when threading the body.
  const letCtx = {
    aggregate: agg ?? undefined,
    part: part ?? undefined,
    valueObject: vo ?? undefined,
  };
  if (op) {
    addTypedLets(bindings, op.body, letCtx);
  } else if (create) {
    addTypedLets(bindings, create.body, letCtx);
  } else if (handle) {
    addTypedLets(bindings, handle.body, letCtx);
  }
  // An `on(e: Event) { … }` reactor / `apply(e: Event) { … }` fold bind their
  // event instance as a typed `payload` local (these params are a LooseName +
  // event cross-ref, not a `Parameter`, so they're bound here rather than via
  // the param list).  Without this the binding types as `unknown` and every
  // field-level check on `e.field` is silently suppressed.  The event param is
  // bound BEFORE the lets so a let initializer can read `e.field`.
  const on = AstUtils.getContainerOfType(node, isOnDecl);
  if (on) {
    if (on.event?.ref)
      bindings.set(on.param, { type: { kind: "payload", ref: on.event.ref }, origin: on });
    addTypedLets(bindings, on.body, letCtx);
  }
  const apply = AstUtils.getContainerOfType(node, isApply);
  if (apply) {
    if (apply.event?.ref) {
      bindings.set(apply.param, { type: { kind: "payload", ref: apply.event.ref }, origin: apply });
    }
    addTypedLets(bindings, apply.body, letCtx);
  }

  // 4. Lambda params — a lambda used as a collection-op arg binds its param to
  //    the receiver collection's element type (`xs.all(x => …)` ⇒ x : element).
  //    Walk innermost→outermost so a nested lambda's param wins on a clash.
  for (
    let lam = AstUtils.getContainerOfType(node, isLambda);
    lam;
    lam = AstUtils.getContainerOfType(lam.$container, isLambda)
  ) {
    if (bindings.has(lam.param)) continue;
    const elem = lambdaParamElementType(lam);
    if (elem) bindings.set(lam.param, { type: elem, origin: lam });
  }

  return makeEnv(undefined, bindings, {
    aggregate: agg ?? undefined,
    part: part ?? undefined,
    valueObject: vo ?? undefined,
  });
}

/** Element type bound to a collection-op lambda's param (`xs.all(p => …)` ⇒ the
 *  element type of `xs`), or undefined when the lambda isn't a collection-op arg. */
function lambdaParamElementType(lam: Lambda): DddType | undefined {
  // Lambda → CallArg → MemberSuffix → PostfixChain.  The lambda is
  // an argument to a method-call suffix on the postfix chain; the
  // element type is the chain's effective receiver-type at the point
  // before this suffix is applied.
  const ms = lam.$container?.$container; // Lambda → CallArg → MemberSuffix (or CallSuffix)
  if (!ms || !isMemberSuffix(ms)) return undefined;
  if (!isCollectionOp(ms.member)) return undefined;
  const chain = ms.$container; // MemberSuffix → PostfixChain
  if (!chain || !isPostfixChain(chain)) return undefined;
  // The receiver type at this suffix is the type after walking head +
  // all suffixes before `ms`.
  const idx = chain.suffixes.indexOf(ms);
  if (idx < 0) return undefined;
  let recvType: DddType = typeOf(chain.head, envForNode(chain.head));
  for (let i = 0; i < idx; i++) {
    recvType = typeAfterSuffix(recvType, chain.suffixes[i]!, envForNode(chain));
  }
  if (recvType.kind === "array") return recvType.element;
  return undefined;
}

function addEntityMembers(
  members: ReadonlyArray<AstNode>,
  bindings: Map<string, { type: DddType; origin: AstNode }>,
): void {
  for (const m of members) {
    if (isProperty(m))
      bindings.set(m.name, {
        type: withTags(resolveTypeRef(m.type), propertySensitivity(m)),
        origin: m,
      });
    else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    else if (isContainment(m)) {
      const partRef = m.partType?.ref;
      if (partRef) {
        const t: DddType = { kind: "entity", ref: partRef };
        bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// iterateEntityMembers — yields each member of an aggregate / part /
// value-object once, with its display kind + type, in declaration order.
// Used by hover (one-line summary) and completion (member-access arm).
// ---------------------------------------------------------------------------

export interface EntityMemberInfo {
  name: string;
  kind: "property" | "containment" | "derived" | "function" | "operation";
  type: DddType;
  node: AstNode;
}

export function iterateEntityMembers(
  target: Aggregate | EntityPart | ValueObject,
): EntityMemberInfo[] {
  const out: EntityMemberInfo[] = [];
  for (const m of target.members) {
    if (isProperty(m)) {
      out.push({
        name: m.name,
        kind: "property",
        type: withTags(resolveTypeRef(m.type), propertySensitivity(m)),
        node: m,
      });
    } else if (isDerivedProp(m)) {
      out.push({ name: m.name, kind: "derived", type: resolveTypeRef(m.type), node: m });
    } else if (isContainment(m)) {
      const partRef = m.partType?.ref;
      if (partRef) {
        const inner: DddType = { kind: "entity", ref: partRef };
        out.push({
          name: m.name,
          kind: "containment",
          type: m.collection ? T.array(inner) : inner,
          node: m,
        });
      }
    } else if (isFunctionDecl(m)) {
      out.push({
        name: m.name,
        kind: "function",
        type: resolveTypeRef(m.returnType),
        node: m,
      });
    } else if (isOperation(m)) {
      // Operations don't have a return type in the type system (they
      // mutate state and return void); record `unknown` so callers
      // that key off `kind` can still display a label.
      out.push({ name: m.name, kind: "operation", type: T.unknown, node: m });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Member enumeration — the single source of truth for "what `.member` names
// are valid on a value of type `t`".  Consumed by the LSP completion provider
// (`ddd-completion.ts`) and the web Model-builder's structured expression
// editor, so member completion behaves identically in VS Code and the
// playground.  This is the enumeration counterpart of the member-access typing
// in `typeOf` — keep the two in step.
// ---------------------------------------------------------------------------

export interface MemberCompletion {
  name: string;
  kind: "field" | "method" | "enum-value";
  /** Short type/signature hint for the completion popup. */
  detail?: string;
}

function entityMemberCompletions(
  ref: Aggregate | EntityPart | ValueObject,
  withId: boolean,
): MemberCompletion[] {
  const out: MemberCompletion[] = [];
  // Aggregates / entity parts expose the magic `id` accessor; value objects don't.
  if (withId) out.push({ name: "id", kind: "field", detail: `${ref.name} id` });
  for (const m of iterateEntityMembers(ref)) {
    out.push({
      name: m.name,
      kind: m.kind === "function" || m.kind === "operation" ? "method" : "field",
      detail: typeToString(m.type),
    });
  }
  return out;
}

export function membersOfType(t: DddType): MemberCompletion[] {
  switch (t.kind) {
    case "array":
      return COLLECTION_OP_SIGNATURES.map((op) => ({
        name: op.name,
        kind: "method",
        detail: `collection op: ${op.signature}`,
      }));
    case "aggregate":
    case "entity":
      return entityMemberCompletions(t.ref, true);
    case "valueobject":
      return entityMemberCompletions(t.ref, false);
    case "id":
      // `X id.member` follows the typed reference into X's schema.
      return entityMemberCompletions(t.target, true);
    case "optional":
      // Member access transparently unwraps an optional (the validator
      // enforces the null-guard separately).
      return membersOfType(t.inner);
    case "primitive": {
      const intrinsics: MemberCompletion[] = intrinsicsForReceiver(t.name).map((s) => ({
        name: s.name,
        kind: "method",
        detail: s.signature,
      }));
      return t.name === "string"
        ? [{ name: "length", kind: "field", detail: "int" }, ...intrinsics]
        : intrinsics;
    }
    case "enum":
      return t.ref.values.map((v) => ({ name: v.name, kind: "enum-value", detail: t.ref.name }));
    case "payload":
      return t.ref.fields.map((f) => ({
        name: f.name,
        kind: "field",
        detail: typeToString(resolveTypeRef(f.type)),
      }));
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// stepIntoNode — like `stepInto` but returns the matching member's AST
// node, not its type.  Used by the LSP definition provider for member
// access (`order.lines` → the `Containment` declaration).
// ---------------------------------------------------------------------------

export function stepIntoNode(t: DddType, name: string): AstNode | undefined {
  if (t.kind === "entity" || t.kind === "aggregate") {
    for (const m of t.ref.members) {
      if (isProperty(m) && m.name === name) return m;
      if (isContainment(m) && m.name === name) return m;
      if (isDerivedProp(m) && m.name === name) return m;
      if (isFunctionDecl(m) && m.name === name) return m;
      if (isOperation(m) && m.name === name) return m;
    }
  }
  if (t.kind === "valueobject") {
    for (const m of t.ref.members) {
      if (isProperty(m) && m.name === name) return m;
      if (isDerivedProp(m) && m.name === name) return m;
      if (isFunctionDecl(m) && m.name === name) return m;
    }
  }
  if (t.kind === "payload") {
    for (const f of t.ref.fields) {
      if (f.name === name) return f;
    }
  }
  return undefined;
}

export interface CalleeSignature {
  name: string;
  params: ReadonlyArray<{ name: string; type: TypeRef }>;
  ret?: TypeRef;
}

/** Resolve a call's callee to its parameter signature — a function / operation
 *  (its params) or a value-object constructor (its declared properties,
 *  positional). Shared by the LSP signature-help provider and the Model
 *  builder's structured editor. Undefined when the callee can't be resolved.
 *
 *  Postfix-chain call: pass the chain plus the index of the call suffix
 *  (in `chain.suffixes`) whose signature we want. */
export function calleeSignature(
  call: import("./generated/ast.js").BuilderCall | { chain: PostfixChain; suffixIdx: number },
): CalleeSignature | undefined {
  if (!("chain" in call)) {
    // BuilderCall branch.
    if (call.$type === "BuilderCall") {
      const ctx = AstUtils.getContainerOfType(call, isBoundedContext);
      const vo = ctx?.members.find(
        (m): m is ValueObject => isValueObject(m) && m.name === call.type,
      );
      if (vo) {
        return {
          name: vo.name,
          params: vo.members.filter(isProperty).map((p) => ({ name: p.name, type: p.type })),
        };
      }
      return undefined;
    }
    return undefined;
  }
  const { chain, suffixIdx } = call;
  const s = chain.suffixes[suffixIdx];
  if (!s) return undefined;
  // MemberSuffix(call=true): a method invocation — resolve via the
  // receiver's type at the point before this suffix is applied.
  if (isMemberSuffix(s)) {
    if (!s.call) return undefined;
    let recvType: DddType = typeOf(chain.head, envForNode(chain.head));
    for (let i = 0; i < suffixIdx; i++) {
      recvType = typeAfterSuffix(recvType, chain.suffixes[i]!, envForNode(chain));
    }
    const decl = stepIntoNode(recvType, s.member);
    if (decl && (isFunctionDecl(decl) || isOperation(decl))) {
      return {
        name: s.member,
        params: decl.params,
        ret: isFunctionDecl(decl) ? decl.returnType : undefined,
      };
    }
    return undefined;
  }
  // CallSuffix: a free call applied to the chain head — only meaningful
  // when the head is a NameRef and this is the first suffix.
  if (suffixIdx === 0 && isNameRef(chain.head)) {
    const name = chain.head.name;
    const owner =
      AstUtils.getContainerOfType(chain, isAggregate) ??
      AstUtils.getContainerOfType(chain, isEntityPart) ??
      AstUtils.getContainerOfType(chain, isValueObject);
    for (const m of owner?.members ?? []) {
      if ((isFunctionDecl(m) || isOperation(m)) && m.name === name) {
        return {
          name: m.name,
          params: m.params,
          ret: isFunctionDecl(m) ? m.returnType : undefined,
        };
      }
    }
    const ctx = AstUtils.getContainerOfType(chain, isBoundedContext);
    const vo = ctx?.members.find((m): m is ValueObject => isValueObject(m) && m.name === name);
    if (vo) {
      return {
        name: vo.name,
        params: vo.members.filter(isProperty).map((p) => ({ name: p.name, type: p.type })),
      };
    }
  }
  return undefined;
}
