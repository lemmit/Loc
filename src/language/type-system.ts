import type { AstNode } from "langium";
import { AstUtils } from "langium";
import type {
  Aggregate,
  BaseType,
  EntityPart,
  EnumDecl,
  Expression,
  FunctionDecl,
  Lambda,
  Operation,
  Parameter,
  Statement,
  TypeRef,
  ValueObject,
} from "./generated/ast.js";
import {
  isAggregate,
  isBinaryExpr,
  isBoolLit,
  isCallExpr,
  isDecLit,
  isEntityPart,
  isEnumDecl,
  isFunctionDecl,
  isIdRef,
  isIdType,
  isIntLit,
  isLambda,
  isMemberAccess,
  isNameRef,
  isNamedType,
  isNewExpr,
  isNowExpr,
  isNullLit,
  isOperation,
  isParameter,
  isParenExpr,
  isPrimitiveType,
  isProperty,
  isStringLit,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
  isContainment,
  isDerivedProp,
  isLetStmt,
} from "./generated/ast.js";

// ---------------------------------------------------------------------------
// Type representation
// ---------------------------------------------------------------------------

export type DddType =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "id"; target: Aggregate | EntityPart }
  | { kind: "enum"; ref: EnumDecl }
  | { kind: "valueobject"; ref: ValueObject }
  | { kind: "aggregate"; ref: Aggregate }
  | { kind: "entity"; ref: EntityPart }
  | { kind: "array"; element: DddType }
  | { kind: "optional"; inner: DddType }
  | { kind: "any" }
  | { kind: "never" }
  | { kind: "unknown" };

export type PrimitiveName = "int" | "long" | "decimal" | "string" | "bool" | "datetime" | "guid";

export const T = {
  prim: (name: PrimitiveName): DddType => ({ kind: "primitive", name }),
  array: (e: DddType): DddType => ({ kind: "array", element: e }),
  opt: (i: DddType): DddType => ({ kind: "optional", inner: i }),
  any: { kind: "any" } as DddType,
  never: { kind: "never" } as DddType,
  unknown: { kind: "unknown" } as DddType,
};

export function typeToString(t: DddType): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `Id<${t.target.name}>`;
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
}

export function typesEqual(a: DddType, b: DddType): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind !== b.kind) return false;
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
// (int → long, int → decimal) is permitted.
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

// ---------------------------------------------------------------------------
// TypeRef → DddType
// ---------------------------------------------------------------------------

export function resolveTypeRef(ref: TypeRef | undefined): DddType {
  if (!ref || !ref.base) return T.unknown;
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
  // `id` of type Id<PartName>).
  part?: EntityPart;
  // The value object currently in scope, if any.
  valueObject?: ValueObject;
}

export function typeOf(expr: Expression | undefined, env: Env): DddType {
  if (!expr) return T.unknown;
  if (isStringLit(expr)) return T.prim("string");
  if (isIntLit(expr)) return T.prim("int");
  if (isDecLit(expr)) return T.prim("decimal");
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
    if (expr.op === "!") return T.prim("bool");
    return t;
  }
  if (isBinaryExpr(expr)) {
    const op = expr.op;
    if (op === "&&" || op === "||") return T.prim("bool");
    if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      return T.prim("bool");
    }
    const lt = typeOf(expr.left, env);
    const rt = typeOf(expr.right, env);
    return arithmeticResult(lt, rt);
  }
  if (isTernaryExpr(expr)) {
    return typeOf(expr.thenExpr, env);
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

function arithmeticResult(a: DddType, b: DddType): DddType {
  if (a.kind === "primitive" && b.kind === "primitive") {
    const order = ["int", "long", "decimal"] as const;
    const ai = (order as readonly string[]).indexOf(a.name);
    const bi = (order as readonly string[]).indexOf(b.name);
    if (ai >= 0 && bi >= 0) return T.prim(order[Math.max(ai, bi)]!);
    if (a.name === "string" && b.name === "string") return T.prim("string");
  }
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
        if (isLambda(arg)) {
          const lambdaEnv: Env = makeEnv(
            env,
            new Map([[arg.param, { type: recvType.element, origin: arg }]]),
          );
          const _bodyType = typeOf(arg.body, lambdaEnv);
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
    // `string.matches(regex)` — slice 21.C operator.  Returns bool;
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
    if (isProperty(m) && m.name === name) return resolveTypeRef(m.type);
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
    if (isProperty(m) && m.name === name) return resolveTypeRef(m.type);
    if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
  }
  return T.unknown;
}

const COLLECTION_OPS = new Set([
  "count",
  "sum",
  "all",
  "any",
  "where",
  "first",
  "firstOrNull",
  "contains",
]);

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
      // otherwise the element type itself.
      const lambdaArg = expr.args[0];
      if (lambdaArg && isLambda(lambdaArg)) {
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

function lookupFunctionInScope(name: string, env: Env): import("./generated/ast.js").FunctionDecl | undefined {
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

function lookupValueObjectByName(
  name: string,
  env: Env,
): ValueObject | undefined {
  // Walk up to bounded context and search value objects.  The
  // generated AST types make `members` an opaque list with mixed
  // member shapes, so we go through `unknown` to apply the structural
  // narrowing the cast below cements.
  let cur: AstNode | undefined = (env.aggregate ?? env.part ?? env.valueObject) as AstNode | undefined;
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

export function collectLetBindings(stmts: import("./generated/ast.js").Statement[]): Map<string, { type: DddType; origin: AstNode }> {
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
    if (isProperty(m) && m.name === name) return resolveTypeRef(m.type);
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
      if (isProperty(m) && m.name === name) return resolveTypeRef(m.type);
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
      if (isProperty(m) && m.name === name) return resolveTypeRef(m.type);
      if (isDerivedProp(m) && m.name === name) return resolveTypeRef(m.type);
    }
  }
  return T.unknown;
}

export function findFunction(
  agg: Aggregate,
  name: string,
): FunctionDecl | undefined {
  for (const m of agg.members) {
    if (isFunctionDecl(m) && m.name === name) return m;
  }
  return undefined;
}

export function findOperation(
  agg: Aggregate,
  name: string,
): Operation | undefined {
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
  const agg = AstUtils.getContainerOfType(node, isAggregate);
  const part = AstUtils.getContainerOfType(node, isEntityPart);
  const vo = AstUtils.getContainerOfType(node, isValueObject);
  const fn = AstUtils.getContainerOfType(node, isFunctionDecl);
  const op = AstUtils.getContainerOfType(node, isOperation);

  const bindings = new Map<string, { type: DddType; origin: AstNode }>();

  // 1. Member bindings — innermost wins, so build outer→inner.
  if (agg && !part) addEntityMembers(agg.members, bindings);
  if (part) addEntityMembers(part.members, bindings);
  if (vo) {
    for (const m of vo.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    }
  }

  // 2. Function / operation parameter bindings.
  const params = fn?.params ?? op?.params ?? [];
  for (const p of params) bindings.set(p.name, { type: paramType(p), origin: p });

  // 3. let-bindings from preceding statements in the enclosing operation.
  if (op) {
    for (const [name, b] of collectLetBindings(op.body)) bindings.set(name, b);
  }

  return makeEnv(undefined, bindings, {
    aggregate: agg ?? undefined,
    part: part ?? undefined,
    valueObject: vo ?? undefined,
  });
}

function addEntityMembers(
  members: ReadonlyArray<AstNode>,
  bindings: Map<string, { type: DddType; origin: AstNode }>,
): void {
  for (const m of members) {
    if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
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
      out.push({ name: m.name, kind: "property", type: resolveTypeRef(m.type), node: m });
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
