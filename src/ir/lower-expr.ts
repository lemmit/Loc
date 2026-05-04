import type { AstNode } from "langium";
import type {
  Aggregate,
  AggregateMember,
  BoundedContext,
  EntityPart,
  EntityPartMember,
  Expression,
  FunctionDecl,
  LValue,
  Operation,
  Statement,
  TypeRef,
  ValueObject,
} from "../language/generated/ast.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isBinaryExpr,
  isBoolLit,
  isCallExpr,
  isContainment,
  isDecLit,
  isDerivedProp,
  isEmitStmt,
  isEntityPart,
  isEnumDecl,
  isFunctionDecl,
  isIdRef,
  isIdType,
  isIntLit,
  isLambda,
  isLetStmt,
  isMemberAccess,
  isNameRef,
  isNamedType,
  isNewExpr,
  isNowExpr,
  isNullLit,
  isObjectLit,
  isOperation,
  isParenExpr,
  isPreconditionStmt,
  isPrimitiveType,
  isProperty,
  isStringLit,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
} from "../language/generated/ast.js";
import { isCollectionOp } from "../language/type-system.js";
import type {
  ExprIR,
  IdValueType,
  PathIR,
  StmtIR,
  TypeIR,
} from "./loom-ir.js";
import { lit } from "./loom-ir.js";

// ---------------------------------------------------------------------------
// Lowering env + the IR-producing layer for expressions, statements, and
// types.  Owns name resolution, member typing, and the pure
// AST-walk helpers.
//
// `lower.ts` (the structure layer) imports from this file; this file
// imports nothing from `lower.ts` — the dependency is one-directional
// so we can always reason about the expression layer in isolation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  /** The enclosing bounded context.  Undefined for `test e2e` blocks
   * that live at the system level, outside any context. */
  ctx?: BoundedContext;
  aggregate?: Aggregate;
  part?: EntityPart;
  valueObject?: ValueObject;
  locals: Map<string, { kind: "param" | "let" | "lambda"; type: TypeIR }>;
}

export function newEnv(ctx: BoundedContext): Env {
  return { ctx, locals: new Map() };
}

export function withLocal(
  env: Env,
  name: string,
  kind: "param" | "let" | "lambda",
  type: TypeIR,
): Env {
  const next = new Map(env.locals);
  next.set(name, { kind, type });
  return { ...env, locals: next };
}

export function inAggregate(env: Env, agg: Aggregate): Env {
  return { ...env, aggregate: agg, part: undefined, valueObject: undefined };
}

export function inPart(env: Env, agg: Aggregate, part: EntityPart): Env {
  return { ...env, aggregate: agg, part, valueObject: undefined };
}

export function inValueObject(env: Env, vo: ValueObject): Env {
  return { ...env, valueObject: vo, aggregate: undefined, part: undefined };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export function lowerType(t: TypeRef | undefined): TypeIR {
  if (!t) return { kind: "primitive", name: "string" };
  let inner = lowerBase(t);
  if (t.array) inner = { kind: "array", element: inner };
  if (t.optional) inner = { kind: "optional", inner };
  return inner;
}

function lowerBase(t: TypeRef): TypeIR {
  const base = t.base;
  if (isPrimitiveType(base)) return { kind: "primitive", name: base.name };
  if (isIdType(base)) {
    const target = base.target?.ref;
    let valueType: IdValueType = "guid";
    if (target && isAggregate(target)) {
      valueType = (target.idKind ?? "guid") as IdValueType;
    } else if (target && isEntityPart(target)) {
      const owner = ancestorAggregate(target);
      valueType = (owner?.idKind ?? "guid") as IdValueType;
    }
    return {
      kind: "id",
      targetName: target?.name ?? "Unknown",
      valueType,
    };
  }
  if (isNamedType(base)) {
    const target = base.target?.ref;
    if (!target) return { kind: "primitive", name: "string" };
    if (isEnumDecl(target)) return { kind: "enum", name: target.name };
    if (isValueObject(target)) return { kind: "valueobject", name: target.name };
    if (isAggregate(target)) return { kind: "entity", name: target.name };
    if (isEntityPart(target)) return { kind: "entity", name: target.name };
  }
  return { kind: "primitive", name: "string" };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export function lowerStatement(
  stmt: Statement,
  env: Env,
): { stmt: StmtIR; envAfter: Env } {
  if (isPreconditionStmt(stmt)) {
    return {
      stmt: {
        kind: "precondition",
        expr: lowerExpr(stmt.expr, env),
        source: cstText(stmt.expr),
      },
      envAfter: env,
    };
  }
  if (isLetStmt(stmt)) {
    const expr = lowerExpr(stmt.expr, env);
    const t = inferExprType(stmt.expr, env);
    const next = withLocal(env, stmt.name, "let", t);
    return {
      stmt: { kind: "let", name: stmt.name, expr, type: t },
      envAfter: next,
    };
  }
  if (isEmitStmt(stmt)) {
    return {
      stmt: {
        kind: "emit",
        eventName: stmt.event?.ref?.name ?? "Unknown",
        fields: stmt.fields.map((f) => ({
          name: f.name,
          value: lowerExpr(f.value, env),
        })),
      },
      envAfter: env,
    };
  }
  if (isAssignOrCallStmt(stmt)) {
    const lv: LValue = stmt.target;
    if (!stmt.op) {
      // `name(args)` — local function or private operation.
      if (lv.call && lv.tail.length === 0) {
        const fn = findFunctionInEnv(env, lv.head);
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        const target: "function" | "private-operation" = fn
          ? "function"
          : "private-operation";
        return {
          stmt: { kind: "call", target, name: lv.head, args },
          envAfter: env,
        };
      }
      // `a.b.c(args)` — chained call (e.g. `api.orders.addLine(...)`
      // in an e2e body).  Synthesise a method-call expression and
      // wrap as an expression-statement.
      if (lv.call && lv.tail.length > 0) {
        let recv: ExprIR = { kind: "ref", name: lv.head, refKind: "unknown" };
        for (let i = 0; i < lv.tail.length - 1; i++) {
          recv = {
            kind: "member",
            receiver: recv,
            member: lv.tail[i]!,
            receiverType: { kind: "primitive", name: "string" },
            memberType: { kind: "primitive", name: "string" },
          };
        }
        const lastMember = lv.tail[lv.tail.length - 1]!;
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        const expr: ExprIR = {
          kind: "method-call",
          receiver: recv,
          member: lastMember,
          args,
          receiverType: { kind: "primitive", name: "string" },
          isCollectionOp: false,
        };
        return { stmt: { kind: "expression", expr }, envAfter: env };
      }
      return {
        stmt: { kind: "call", target: "function", name: lv.head, args: [] },
        envAfter: env,
      };
    }
    const path: PathIR = { segments: [lv.head, ...lv.tail] };
    const value = lowerExpr(stmt.value, env);
    if (stmt.op === ":=") {
      const targetType = pathType(path, env);
      return {
        stmt: { kind: "assign", target: path, value, targetType },
        envAfter: env,
      };
    }
    if (stmt.op === "+=" || stmt.op === "-=") {
      const targetType = pathType(path, env);
      const elementType =
        targetType.kind === "array" ? targetType.element : targetType;
      return {
        stmt: {
          kind: stmt.op === "+=" ? "add" : "remove",
          target: path,
          value,
          elementType,
        },
        envAfter: env,
      };
    }
  }
  // Fallback no-op
  return {
    stmt: { kind: "call", target: "function", name: "<unknown>", args: [] },
    envAfter: env,
  };
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export function lowerExpr(expr: Expression | undefined, env: Env): ExprIR {
  if (!expr) return lit("null", "null");
  if (isStringLit(expr)) return lit("string", expr.value);
  if (isIntLit(expr)) return lit("int", String(expr.value));
  if (isDecLit(expr)) return lit("decimal", expr.value);
  if (isBoolLit(expr)) return lit("bool", expr.value);
  if (isNullLit(expr)) return lit("null", "null");
  if (isNowExpr(expr)) return lit("now", "now");
  if (isThisRef(expr)) return { kind: "this" };
  if (isIdRef(expr)) return { kind: "id" };
  if (isParenExpr(expr)) return { kind: "paren", inner: lowerExpr(expr.inner, env) };
  if (isUnaryExpr(expr)) {
    return {
      kind: "unary",
      op: expr.op as "-" | "!",
      operand: lowerExpr(expr.operand, env),
    };
  }
  if (isBinaryExpr(expr)) {
    return {
      kind: "binary",
      op: expr.op,
      left: lowerExpr(expr.left, env),
      right: lowerExpr(expr.right, env),
    };
  }
  if (isTernaryExpr(expr)) {
    return {
      kind: "ternary",
      cond: lowerExpr(expr.condition, env),
      then: lowerExpr(expr.thenExpr, env),
      otherwise: lowerExpr(expr.elseExpr, env),
    };
  }
  if (isLambda(expr)) {
    const inner = withLocal(env, expr.param, "lambda", { kind: "primitive", name: "string" });
    return {
      kind: "lambda",
      param: expr.param,
      body: lowerExpr(expr.body, inner),
    };
  }
  if (isObjectLit(expr)) {
    return {
      kind: "object",
      fields: expr.fields.map((f) => ({
        name: f.name,
        value: lowerExpr(f.value, env),
      })),
    };
  }
  if (isNewExpr(expr)) {
    return {
      kind: "new",
      partName: expr.partType?.ref?.name ?? "Unknown",
      fields: expr.fields.map((f) => ({
        name: f.name,
        value: lowerExpr(f.value, env),
      })),
    };
  }
  if (isMemberAccess(expr)) {
    const recv = lowerExpr(expr.receiver, env);
    const recvType = inferExprType(expr.receiver, env);
    if (expr.call) {
      const args = expr.args.map((a) => lowerExpr(a, env));
      const collectionOp = isCollectionOp(expr.member);
      return {
        kind: "method-call",
        receiver: recv,
        member: expr.member,
        args,
        receiverType: recvType,
        isCollectionOp: collectionOp,
      };
    }
    return {
      kind: "member",
      receiver: recv,
      member: expr.member,
      receiverType: recvType,
      memberType: stepInto(recvType, expr.member, env),
    };
  }
  if (isCallExpr(expr)) {
    const callee = expr.callee;
    if (isNameRef(callee)) {
      const args = expr.args.map((a) => lowerExpr(a, env));
      const callKind = resolveCallKind(callee.name, env);
      return { kind: "call", callKind, name: callee.name, args };
    }
    return {
      kind: "call",
      callKind: "free",
      name: "<expr>",
      args: expr.args.map((a) => lowerExpr(a, env)),
    };
  }
  if (isNameRef(expr)) {
    return resolveNameRef(expr.name, env);
  }
  return lit("null", "null");
}

function resolveNameRef(name: string, env: Env): ExprIR {
  const local = env.locals.get(name);
  if (local) {
    const refKind = local.kind;
    return { kind: "ref", name, refKind, type: local.type };
  }
  // Property of enclosing entity / value object?
  const owner = env.part ?? env.aggregate ?? env.valueObject;
  if (owner) {
    const isVo = !!env.valueObject;
    for (const m of owner.members) {
      if (isProperty(m) && m.name === name) {
        return {
          kind: "ref",
          name,
          refKind: isVo ? "this-vo-prop" : "this-prop",
          type: lowerType(m.type),
        };
      }
      if (isContainment(m) && m.name === name) {
        const partName = m.partType?.ref?.name ?? "Unknown";
        const t: TypeIR = m.collection
          ? { kind: "array", element: { kind: "entity", name: partName } }
          : { kind: "entity", name: partName };
        return { kind: "ref", name, refKind: "this-prop", type: t };
      }
      if (isDerivedProp(m) && m.name === name) {
        return {
          kind: "ref",
          name,
          refKind: "this-derived",
          type: lowerType(m.type),
        };
      }
      if (isFunctionDecl(m) && m.name === name) {
        return { kind: "ref", name, refKind: "helper-fn" };
      }
    }
  }
  // Enum value lookup — only when an enclosing context exists.  E2E
  // test bodies have no `ctx`; bare names there are treated as
  // unresolved refs and rendered verbatim by the e2e renderer.
  if (env.ctx) {
    for (const m of env.ctx.members) {
      if (isEnumDecl(m)) {
        for (const v of m.values) {
          if (v.name === name) {
            return {
              kind: "ref",
              name,
              refKind: "enum-value",
              enumName: m.name,
              type: { kind: "enum", name: m.name },
            };
          }
        }
      }
    }
  }
  return { kind: "ref", name, refKind: "unknown" };
}

function resolveCallKind(
  name: string,
  env: Env,
): "function" | "value-object-ctor" | "private-operation" | "free" {
  // Check enclosing aggregate / part for functions and operations
  const owners: Array<Aggregate | EntityPart | ValueObject | undefined> = [
    env.part,
    env.aggregate,
    env.valueObject,
  ];
  for (const o of owners) {
    if (!o) continue;
    for (const m of o.members) {
      if (isFunctionDecl(m) && m.name === name) return "function";
      // Operations only appear inside aggregates / entity parts, not
      // value objects.  The `o` guard narrows `m`'s union accordingly.
      if (isAggregate(o) || isEntityPart(o)) {
        const opM = m as AggregateMember | EntityPartMember;
        if (isOperation(opM) && opM.name === name) return "private-operation";
      }
    }
  }
  // Value-object constructor (only when a context is in scope).
  if (env.ctx) {
    for (const m of env.ctx.members) {
      if (isValueObject(m) && m.name === name) return "value-object-ctor";
    }
  }
  return "free";
}

// ---------------------------------------------------------------------------
// Type inference for expressions (best-effort, used to inform IR nodes)
// ---------------------------------------------------------------------------

export function inferExprType(
  expr: Expression | undefined,
  env: Env,
): TypeIR {
  if (!expr) return { kind: "primitive", name: "string" };
  if (isStringLit(expr)) return { kind: "primitive", name: "string" };
  if (isIntLit(expr)) return { kind: "primitive", name: "int" };
  if (isDecLit(expr)) return { kind: "primitive", name: "decimal" };
  if (isBoolLit(expr)) return { kind: "primitive", name: "bool" };
  if (isNullLit(expr)) return { kind: "primitive", name: "string" };
  if (isNowExpr(expr)) return { kind: "primitive", name: "datetime" };
  if (isThisRef(expr)) {
    if (env.part) return { kind: "entity", name: env.part.name };
    if (env.aggregate) return { kind: "entity", name: env.aggregate.name };
    if (env.valueObject) return { kind: "valueobject", name: env.valueObject.name };
    return { kind: "primitive", name: "string" };
  }
  if (isIdRef(expr)) {
    if (env.part) return { kind: "id", targetName: env.part.name, valueType: "guid" };
    if (env.aggregate) {
      return {
        kind: "id",
        targetName: env.aggregate.name,
        valueType: (env.aggregate.idKind ?? "guid") as IdValueType,
      };
    }
    return { kind: "primitive", name: "string" };
  }
  if (isParenExpr(expr)) return inferExprType(expr.inner, env);
  if (isUnaryExpr(expr)) {
    if (expr.op === "!") return { kind: "primitive", name: "bool" };
    return inferExprType(expr.operand, env);
  }
  if (isBinaryExpr(expr)) {
    const op = expr.op;
    if (
      op === "&&" ||
      op === "||" ||
      op === "==" ||
      op === "!=" ||
      op === "<" ||
      op === "<=" ||
      op === ">" ||
      op === ">="
    ) {
      return { kind: "primitive", name: "bool" };
    }
    const left = inferExprType(expr.left, env);
    const right = inferExprType(expr.right, env);
    return widenNumeric(left, right);
  }
  if (isTernaryExpr(expr)) return inferExprType(expr.thenExpr, env);
  if (isLambda(expr)) return { kind: "primitive", name: "string" };
  if (isNewExpr(expr)) {
    return { kind: "entity", name: expr.partType?.ref?.name ?? "Unknown" };
  }
  if (isMemberAccess(expr)) {
    const recvType = inferExprType(expr.receiver, env);
    return memberType(recvType, expr.member, env);
  }
  if (isCallExpr(expr)) {
    const callee = expr.callee;
    if (isNameRef(callee)) {
      const fn = findFunctionInEnv(env, callee.name);
      if (fn) return lowerType(fn.returnType);
      const vo = findValueObjectByName(env, callee.name);
      if (vo) return { kind: "valueobject", name: vo.name };
    }
    return { kind: "primitive", name: "string" };
  }
  if (isNameRef(expr)) {
    const ref = resolveNameRef(expr.name, env);
    if (ref.kind === "ref" && ref.type) return ref.type;
    return { kind: "primitive", name: "string" };
  }
  return { kind: "primitive", name: "string" };
}

function widenNumeric(a: TypeIR, b: TypeIR): TypeIR {
  if (a.kind === "primitive" && b.kind === "primitive") {
    const order = ["int", "long", "decimal"] as const;
    type NumericName = (typeof order)[number];
    const ai = (order as readonly string[]).indexOf(a.name);
    const bi = (order as readonly string[]).indexOf(b.name);
    if (ai >= 0 && bi >= 0) {
      return { kind: "primitive", name: order[Math.max(ai, bi)] as NumericName };
    }
  }
  return a;
}

function memberType(t: TypeIR, name: string, env: Env): TypeIR {
  if (t.kind === "array") {
    switch (name) {
      case "count":
        return { kind: "primitive", name: "int" };
      case "sum":
        return { kind: "primitive", name: "decimal" };
      case "all":
      case "any":
        return { kind: "primitive", name: "bool" };
      case "where":
        return t;
      case "first":
        return t.element;
      case "firstOrNull":
        return { kind: "optional", inner: t.element };
      default:
        return { kind: "primitive", name: "string" };
    }
  }
  if (t.kind === "entity") {
    const target = findEntityByName(env, t.name);
    if (target) return memberOnEntity(target, name);
  }
  if (t.kind === "valueobject") {
    const vo = findValueObjectByName(env, t.name);
    if (vo) return memberOnValueObject(vo, name);
  }
  if (t.kind === "primitive" && t.name === "string" && name === "length") {
    return { kind: "primitive", name: "int" };
  }
  return { kind: "primitive", name: "string" };
}

function memberOnEntity(target: Aggregate | EntityPart, name: string): TypeIR {
  if (name === "id") {
    const idValue: IdValueType = isAggregate(target)
      ? ((target.idKind ?? "guid") as IdValueType)
      : "guid";
    return { kind: "id", targetName: target.name, valueType: idValue };
  }
  for (const m of target.members) {
    if (isProperty(m) && m.name === name) return lowerType(m.type);
    if (isContainment(m) && m.name === name) {
      const partName = m.partType?.ref?.name ?? "Unknown";
      return m.collection
        ? { kind: "array", element: { kind: "entity", name: partName } }
        : { kind: "entity", name: partName };
    }
    if (isDerivedProp(m) && m.name === name) {
      return lowerType(m.type);
    }
  }
  return { kind: "primitive", name: "string" };
}

function memberOnValueObject(vo: ValueObject, name: string): TypeIR {
  for (const m of vo.members) {
    if (isProperty(m) && m.name === name) return lowerType(m.type);
    if (isDerivedProp(m) && m.name === name) {
      return lowerType(m.type);
    }
  }
  return { kind: "primitive", name: "string" };
}

function findEntityByName(
  env: Env,
  name: string,
): Aggregate | EntityPart | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isAggregate(m)) {
      if (m.name === name) return m;
      for (const inner of m.members) {
        if (isEntityPart(inner) && inner.name === name) return inner;
      }
    }
  }
  return undefined;
}

function findValueObjectByName(env: Env, name: string): ValueObject | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isValueObject(m) && m.name === name) return m;
  }
  return undefined;
}

export function findFunctionInEnv(
  env: Env,
  name: string,
): FunctionDecl | undefined {
  const owners: Array<Aggregate | EntityPart | ValueObject | undefined> = [
    env.part,
    env.aggregate,
    env.valueObject,
  ];
  for (const o of owners) {
    if (!o) continue;
    for (const m of o.members) {
      if (isFunctionDecl(m) && m.name === name) return m;
    }
  }
  return undefined;
}

export function findOperationInEnv(
  env: Env,
  name: string,
): Operation | undefined {
  if (!env.aggregate) return undefined;
  for (const m of env.aggregate.members) {
    if (isOperation(m) && m.name === name) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Path typing — for assign/add/remove statements
// ---------------------------------------------------------------------------

function pathType(path: PathIR, env: Env): TypeIR {
  if (path.segments.length === 0) return { kind: "primitive", name: "string" };
  const head = path.segments[0]!;
  let cur: TypeIR;
  // Try locals
  const local = env.locals.get(head);
  if (local) cur = local.type;
  else if (env.aggregate) cur = memberOnEntity(env.aggregate, head);
  else cur = { kind: "primitive", name: "string" };
  for (let i = 1; i < path.segments.length; i++) {
    cur = stepInto(cur, path.segments[i]!, env);
  }
  return cur;
}

function stepInto(t: TypeIR, name: string, env: Env): TypeIR {
  if (t.kind === "entity") {
    const target = findEntityByName(env, t.name);
    if (target) return memberOnEntity(target, name);
  }
  if (t.kind === "valueobject") {
    const vo = findValueObjectByName(env, t.name);
    if (vo) return memberOnValueObject(vo, name);
  }
  return { kind: "primitive", name: "string" };
}

// ---------------------------------------------------------------------------
// Misc AST helpers
// ---------------------------------------------------------------------------

export function ancestorAggregate(node: AstNode): Aggregate | undefined {
  let cur: AstNode | undefined = node;
  while (cur) {
    if (isAggregate(cur)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

export function cstText(node: AstNode | undefined): string {
  if (!node) return "";
  const cst = (node as { $cstNode?: { text?: string } }).$cstNode;
  return cst?.text ?? "<expr>";
}
