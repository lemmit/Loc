import type { AstNode } from "langium";
import { AstUtils } from "langium";
import type { PrimitiveName } from "../ir/loom-ir.js";
import type {
  Aggregate,
  BaseType,
  CallExpr,
  EntityPart,
  EnumDecl,
  Expression,
  FunctionDecl,
  Lambda,
  MemberAccess,
  Operation,
  Parameter,
  Property,
  Repository,
  TypeRef,
  ValueObject,
} from "./generated/ast.js";
import {
  isAggregate,
  isBinaryExpr,
  isBoolLit,
  isBoundedContext,
  isCallExpr,
  isContainment,
  isDecLit,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isFindDecl,
  isFunctionDecl,
  isIdRef,
  isIdType,
  isIntLit,
  isLambda,
  isLetStmt,
  isMemberAccess,
  isMoneyLit,
  isNamedType,
  isNameRef,
  isNewExpr,
  isNowExpr,
  isNullLit,
  isOperation,
  isParenExpr,
  isPrimitiveConversion,
  isPrimitiveType,
  isProperty,
  isStringLit,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
  isView,
  isWorkflow,
} from "./generated/ast.js";

// ---------------------------------------------------------------------------
// Type representation
// ---------------------------------------------------------------------------

/** Information-flow sensitivity labels carried by a value's type.  An
 * empty / absent tag set means "clean".  Tags are opaque identifiers
 * declared at field sites via `sensitive(<tag>, ...)`; the type system
 * propagates them through expression composition (concat, ternary,
 * call returns) so a value can't be laundered clean by reshaping the
 * expression.  See `docs/proposals/sensitivity-and-compliance.md`. */
export type SensitivityTags = readonly string[];

export type DddType =
  | { kind: "primitive"; name: PrimitiveName; sensitivity?: SensitivityTags }
  | { kind: "id"; target: Aggregate | EntityPart; sensitivity?: SensitivityTags }
  | { kind: "enum"; ref: EnumDecl; sensitivity?: SensitivityTags }
  | { kind: "valueobject"; ref: ValueObject; sensitivity?: SensitivityTags }
  | { kind: "aggregate"; ref: Aggregate; sensitivity?: SensitivityTags }
  | { kind: "entity"; ref: EntityPart; sensitivity?: SensitivityTags }
  | { kind: "array"; element: DddType; sensitivity?: SensitivityTags }
  | { kind: "optional"; inner: DddType; sensitivity?: SensitivityTags }
  | { kind: "any"; sensitivity?: SensitivityTags }
  | { kind: "never"; sensitivity?: SensitivityTags }
  | { kind: "unknown"; sensitivity?: SensitivityTags };

// `PrimitiveName` is the canonical primitive-type set sourced from
// `src/ir/loom-ir.ts` (the IR layer downstream consumes the same
// union the type-system layer assigns names against — kept in one
// place so a new primitive shows up in both without N parallel
// updates).  See `experience_gathered.md` → "Adding a new primitive".
export type { PrimitiveName };

export const T = {
  prim: (name: PrimitiveName): DddType => ({ kind: "primitive", name }),
  array: (e: DddType): DddType => ({ kind: "array", element: e }),
  opt: (i: DddType): DddType => ({ kind: "optional", inner: i }),
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
      case "array":
        return `${typeToString(t.element)}[]`;
      case "optional":
        return `${typeToString(t.inner)}?`;
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
    return value.kind === "never" || isAssignable(value, target.inner) || value.kind === "optional";
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
  if (isBinaryExpr(expr)) {
    const op = expr.op;
    // Logical / comparison ops produce a fresh bool — by convention low
    // bandwidth implicit flows aren't tracked, so no propagation.
    if (op === "&&" || op === "||") return T.prim("bool");
    if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      return T.prim("bool");
    }
    const lt = typeOf(expr.left, env);
    const rt = typeOf(expr.right, env);
    return arithmeticResult(lt, rt, op);
  }
  if (isTernaryExpr(expr)) {
    // Union the branches' sensitivity — the chosen value could come from
    // either, so the resulting value is as tainted as either branch is.
    const thenT = typeOf(expr.thenExpr, env);
    const elseT = typeOf(expr.elseExpr, env);
    return withTags(thenT, elseT.sensitivity);
  }
  if (isLambda(expr)) {
    // Lambda type is contextual; without a target type it's unknown.
    return T.unknown;
  }
  if (isNewExpr(expr)) {
    const part = expr.partType?.ref;
    if (part) return { kind: "entity", ref: part };
    return T.unknown;
  }
  if (isMemberAccess(expr)) {
    return typeOfMemberAccess(expr, env);
  }
  if (isCallExpr(expr)) {
    return typeOfCall(expr, env);
  }
  if (isNameRef(expr)) {
    const looked = env.resolve(expr.name);
    return looked?.type ?? T.unknown;
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

  if (a.kind === "primitive" && b.kind === "primitive") {
    const order = ["int", "long", "decimal"] as const;
    const ai = (order as readonly string[]).indexOf(a.name);
    const bi = (order as readonly string[]).indexOf(b.name);
    if (ai >= 0 && bi >= 0) return withTags(T.prim(order[Math.max(ai, bi)]!), tags);
  }
  return withTags(T.unknown, tags);
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
function isImplicitlyStringifiable(t: DddType): boolean {
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
  return false;
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

function typeOfMemberAccess(expr: import("./generated/ast.js").MemberAccess, env: Env): DddType {
  const recvType = typeOf(expr.receiver, env);
  const memberName = expr.member;
  // Collection ops on arrays — type-check lambda args with the element
  // type bound to the lambda parameter, so `transactions.all(t => …)`
  // sees `t: AccountTransaction`.
  if (recvType.kind === "array") {
    if (expr.call) {
      for (const arg of expr.args) {
        // Call args wrap an Expression in a `CallArg`
        // node carrying an optional `name:` prefix.  Look at the
        // wrapped value, not the wrapper itself, when checking for
        // Lambda shape.
        const argExpr = arg.value;
        if (isLambda(argExpr) && argExpr.body) {
          const lambdaEnv: Env = makeEnv(
            env,
            new Map([[argExpr.param, { type: recvType.element, origin: argExpr }]]),
          );
          const _bodyType = typeOf(argExpr.body, lambdaEnv);
          void _bodyType;
        }
      }
    }
    return collectionOpType(recvType, memberName, expr, env);
  }
  // Member access on entities/value objects/aggregates
  if (recvType.kind === "entity" || recvType.kind === "aggregate") {
    return lookupEntityMember(recvType.ref, memberName);
  }
  if (recvType.kind === "valueobject") {
    return lookupValueObjectMember(recvType.ref, memberName);
  }
  if (recvType.kind === "primitive" && recvType.name === "string") {
    if (memberName === "length") return T.prim("int");
    // `string.matches(regex)` operator.  Returns bool;
    // argument is a string literal (the validator enforces that
    // separately so a non-literal arg becomes a clear diagnostic
    // rather than `unknown`).
    if (memberName === "matches" && expr.call) return T.prim("bool");
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

// Canonical collection-op catalogue — the single source for both the
// membership check (`isCollectionOp`) and member enumeration (`membersOfType`).
const COLLECTION_OP_SIGNATURES: ReadonlyArray<{ name: string; signature: string }> = [
  { name: "count", signature: "int" },
  { name: "sum", signature: "(λ): decimal" },
  { name: "all", signature: "(λ): bool" },
  { name: "any", signature: "(λ): bool" },
  { name: "where", signature: "(λ): T[]" },
  { name: "first", signature: "T" },
  { name: "firstOrNull", signature: "T?" },
  { name: "contains", signature: "bool" },
];
const COLLECTION_OPS = new Set(COLLECTION_OP_SIGNATURES.map((o) => o.name));

function collectionOpType(
  recv: { kind: "array"; element: DddType },
  name: string,
  expr: import("./generated/ast.js").MemberAccess,
  env: Env,
): DddType {
  switch (name) {
    case "count":
      return T.prim("int");
    case "sum": {
      // sum returns the lambda's body type when one is given;
      // otherwise the element type itself.  Args are CallArg
      // wrappers — peek through `.value`.
      const callArg = expr.args[0];
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
    case "where":
      return T.array(recv.element);
    case "first":
      return recv.element;
    case "firstOrNull":
      return T.opt(recv.element);
    default:
      return T.unknown;
  }
}

function typeOfCall(expr: import("./generated/ast.js").CallExpr, env: Env): DddType {
  const callee = expr.callee;
  if (isNameRef(callee)) {
    const sym = env.resolve(callee.name);
    if (sym && isFunctionDecl(sym.origin)) {
      return resolveTypeRef(sym.origin.returnType);
    }
    if (sym && isValueObject(sym.origin)) {
      return { kind: "valueobject", ref: sym.origin };
    }
    // Look up functions / value-object constructors / operations declared
    // in the enclosing aggregate or part.
    const fn = lookupFunctionInScope(callee.name, env);
    if (fn) return resolveTypeRef(fn.returnType);
    const vo = lookupValueObjectByName(callee.name, env);
    if (vo) return { kind: "valueobject", ref: vo };
    return T.unknown;
  }
  return T.unknown;
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

function lookupValueObjectByName(name: string, env: Env): ValueObject | undefined {
  // Walk up to bounded context and search value objects.  The
  // generated AST types make `members` an opaque list with mixed
  // member shapes, so we go through `unknown` to apply the structural
  // narrowing the cast below cements.
  let cur: AstNode | undefined = (env.aggregate ?? env.part ?? env.valueObject) as
    | AstNode
    | undefined;
  while (cur && cur.$type !== "BoundedContext") cur = cur.$container;
  if (!cur) return undefined;
  const ctxMembers = (cur as unknown as { members: AstNode[] }).members;
  for (const m of ctxMembers) {
    if (m.$type === "ValueObject" && (m as ValueObject).name === name) {
      return m as ValueObject;
    }
  }
  return undefined;
}

export function isCollectionOp(name: string): boolean {
  return COLLECTION_OPS.has(name);
}

// Canonical test-assertion matcher catalogue — a built-in "intrinsic"
// library the compiler knows by name (resolved into the IR, then lowered
// per-backend to Playwright / vitest / xUnit / ExUnit).  `on` records
// whether the matcher reads a DOM locator (web-first, auto-retrying) or a
// plain value; `arity` is the fixed positional-argument count for
// validation. This is the surface declared as DATA — adding a matcher is
// a table entry plus a per-backend lowering, not a renderer special-case.
export interface MatcherSig {
  name: string;
  arity: number;
  on: "locator" | "value";
  /** When this matcher reads a locator, the negated form is `not.<name>`. */
  negatable: boolean;
}
const INTRINSIC_MATCHER_SIGNATURES: ReadonlyArray<MatcherSig> = [
  { name: "toBe", arity: 1, on: "value", negatable: true },
  { name: "toBeGreaterThan", arity: 1, on: "value", negatable: true },
  { name: "toBeGreaterThanOrEqual", arity: 1, on: "value", negatable: true },
  { name: "toBeLessThan", arity: 1, on: "value", negatable: true },
  { name: "toBeLessThanOrEqual", arity: 1, on: "value", negatable: true },
  { name: "toHaveText", arity: 1, on: "locator", negatable: true },
  { name: "toHaveCount", arity: 1, on: "locator", negatable: true },
  { name: "toBeVisible", arity: 0, on: "locator", negatable: true },
];
const INTRINSIC_MATCHERS = new Map(INTRINSIC_MATCHER_SIGNATURES.map((m) => [m.name, m]));

export function isIntrinsicMatcher(name: string): boolean {
  return INTRINSIC_MATCHERS.has(name);
}

export function intrinsicMatcherSig(name: string): MatcherSig | undefined {
  return INTRINSIC_MATCHERS.get(name);
}

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

export function collectLetBindings(
  stmts: import("./generated/ast.js").Statement[],
): Map<string, { type: DddType; origin: AstNode }> {
  const m = new Map<string, { type: DddType; origin: AstNode }>();
  for (const s of stmts) {
    if (isLetStmt(s)) {
      // Type inferred from the expression at the point of binding.
      m.set(s.name, { type: T.unknown, origin: s });
    }
  }
  return m;
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
  const view = AstUtils.getContainerOfType(node, isView);
  const wf = AstUtils.getContainerOfType(node, isWorkflow);

  // The `this`/root aggregate: an enclosing aggregate container, else the
  // repository's `for` aggregate (find filters) or the view's `from` aggregate
  // (view filters / binds) — both reached through a cross-reference, not
  // containment.  Workflows orchestrate across aggregates and have no `this`.
  const agg =
    AstUtils.getContainerOfType(node, isAggregate) ??
    (find ? (find.$container as Repository | undefined)?.aggregate?.ref : undefined) ??
    (view ? view.source?.ref : undefined);

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

  // 2. Function / operation / find / workflow parameter bindings.
  const params = fn?.params ?? op?.params ?? find?.params ?? wf?.params ?? [];
  for (const p of params) bindings.set(p.name, { type: paramType(p), origin: p });

  // 3. let-bindings from preceding statements in the enclosing operation / workflow.
  const bodyOwner = op ?? wf;
  if (bodyOwner) {
    for (const [name, b] of collectLetBindings(bodyOwner.body)) bindings.set(name, b);
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
  const ma = lam.$container?.$container; // Lambda → CallArg → MemberAccess
  if (ma && isMemberAccess(ma) && isCollectionOp(ma.member) && ma.receiver) {
    const recvType = typeOf(ma.receiver, envForNode(ma.receiver));
    if (recvType.kind === "array") return recvType.element;
  }
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
    case "primitive":
      return t.name === "string" ? [{ name: "length", kind: "field", detail: "int" }] : [];
    case "enum":
      return t.ref.values.map((v) => ({ name: v.name, kind: "enum-value", detail: t.ref.name }));
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
 *  builder's structured editor. Undefined when the callee can't be resolved. */
export function calleeSignature(call: CallExpr | MemberAccess): CalleeSignature | undefined {
  if (isMemberAccess(call)) {
    if (!call.call) return undefined;
    const decl = stepIntoNode(typeOf(call.receiver, envForNode(call)), call.member);
    if (decl && (isFunctionDecl(decl) || isOperation(decl))) {
      return {
        name: call.member,
        params: decl.params,
        ret: isFunctionDecl(decl) ? decl.returnType : undefined,
      };
    }
    return undefined;
  }
  const callee = call.callee;
  if (!isNameRef(callee)) return undefined;
  // Function / operation on the enclosing entity.
  const owner =
    AstUtils.getContainerOfType(call, isAggregate) ??
    AstUtils.getContainerOfType(call, isEntityPart) ??
    AstUtils.getContainerOfType(call, isValueObject);
  for (const m of owner?.members ?? []) {
    if ((isFunctionDecl(m) || isOperation(m)) && m.name === callee.name) {
      return { name: m.name, params: m.params, ret: isFunctionDecl(m) ? m.returnType : undefined };
    }
  }
  // Value-object constructor: its properties, positional.
  const ctx = AstUtils.getContainerOfType(call, isBoundedContext);
  const vo = ctx?.members.find((m): m is ValueObject => isValueObject(m) && m.name === callee.name);
  if (vo) {
    return {
      name: vo.name,
      params: vo.members.filter(isProperty).map((p) => ({ name: p.name, type: p.type })),
    };
  }
  return undefined;
}
