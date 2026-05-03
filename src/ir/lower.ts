import type { AstNode } from "langium";
import type {
  Aggregate,
  BoundedContext,
  EntityPart,
  EnumDecl,
  EventDecl,
  Expression,
  FunctionDecl,
  Lambda,
  LValue,
  Model,
  Operation,
  Property,
  Repository,
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
  isEventDecl,
  isFunctionDecl,
  isIdRef,
  isIdType,
  isIntLit,
  isInvariant,
  isLambda,
  isLetStmt,
  isMemberAccess,
  isNameRef,
  isNamedType,
  isNewExpr,
  isNowExpr,
  isNullLit,
  isOperation,
  isParenExpr,
  isPreconditionStmt,
  isPrimitiveType,
  isProperty,
  isRepository,
  isStringLit,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
} from "../language/generated/ast.js";
import {
  isCollectionOp,
} from "../language/type-system.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  EnumIR,
  EventIR,
  ExprIR,
  FieldIR,
  FunctionIR,
  IdValueType,
  InvariantIR,
  LoomModel,
  OperationIR,
  ParamIR,
  PathIR,
  RepositoryIR,
  StmtIR,
  TypeIR,
  ValueObjectIR,
} from "./loom-ir.js";
import { lit } from "./loom-ir.js";

// ---------------------------------------------------------------------------
// Lowering context — tracks the bounded context, the aggregate / part /
// value-object the current expression sits inside, and the local symbols
// (parameters, let-bindings, lambda params).
// ---------------------------------------------------------------------------

interface Env {
  ctx: BoundedContext;
  aggregate?: Aggregate;
  part?: EntityPart;
  valueObject?: ValueObject;
  locals: Map<string, { kind: "param" | "let" | "lambda"; type: TypeIR }>;
}

function newEnv(ctx: BoundedContext): Env {
  return { ctx, locals: new Map() };
}

function withLocal(env: Env, name: string, kind: "param" | "let" | "lambda", type: TypeIR): Env {
  const next = new Map(env.locals);
  next.set(name, { kind, type });
  return { ...env, locals: next };
}

function inAggregate(env: Env, agg: Aggregate): Env {
  return { ...env, aggregate: agg, part: undefined, valueObject: undefined };
}

function inPart(env: Env, agg: Aggregate, part: EntityPart): Env {
  return { ...env, aggregate: agg, part, valueObject: undefined };
}

function inValueObject(env: Env, vo: ValueObject): Env {
  return { ...env, valueObject: vo, aggregate: undefined, part: undefined };
}

// ---------------------------------------------------------------------------
// Entry: lower a model into Loom IR
// ---------------------------------------------------------------------------

export function lowerModel(model: Model): LoomModel {
  return {
    contexts: model.contexts.map(lowerContext),
  };
}

function lowerContext(ctx: BoundedContext): BoundedContextIR {
  const env = newEnv(ctx);
  const enums: EnumIR[] = [];
  const valueObjects: ValueObjectIR[] = [];
  const events: EventIR[] = [];
  const aggregates: AggregateIR[] = [];
  const repositories: RepositoryIR[] = [];
  for (const m of ctx.members) {
    if (isEnumDecl(m)) enums.push(lowerEnum(m));
    else if (isValueObject(m)) valueObjects.push(lowerValueObject(m, env));
    else if (isEventDecl(m)) events.push(lowerEvent(m));
    else if (isAggregate(m)) aggregates.push(lowerAggregate(m, env));
    else if (isRepository(m)) repositories.push(lowerRepository(m));
  }
  return {
    name: ctx.name,
    enums,
    valueObjects,
    events,
    aggregates,
    repositories,
  };
}

function lowerEnum(e: EnumDecl): EnumIR {
  return { name: e.name, values: e.values.map((v) => v.name) };
}

function lowerValueObject(vo: ValueObject, env: Env): ValueObjectIR {
  const inner = inValueObject(env, vo);
  return {
    name: vo.name,
    fields: vo.members.filter(isProperty).map((p) => lowerField(p)),
    derived: vo.members.filter(isDerivedProp).map((d) =>
      lowerDerived(d, inner),
    ),
    invariants: vo.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
    functions: vo.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

function lowerEvent(e: EventDecl): EventIR {
  return {
    name: e.name,
    fields: e.fields.map((f) => lowerField(f)),
  };
}

function lowerAggregate(agg: Aggregate, env: Env): AggregateIR {
  const idValueType = (agg.idKind ?? "guid") as IdValueType;
  const inner = inAggregate(env, agg);
  const props = agg.members.filter(isProperty) as Property[];
  const containments = agg.members.filter(isContainment).map(lowerContainment);
  const parts: EntityPartIR[] = [];
  for (const m of agg.members) {
    if (isEntityPart(m)) parts.push(lowerEntityPart(m, agg, inner));
  }
  const derived = agg.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner));
  const invariants = agg.members.filter(isInvariant).map((i) => lowerInvariant(i, inner));
  const functions = agg.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner));
  const operations = (agg.members.filter(isOperation) as Operation[]).map((op) =>
    lowerOperation(op, inner),
  );
  return {
    name: agg.name,
    idValueType,
    fields: props.map(lowerField),
    contains: containments,
    derived,
    invariants,
    functions,
    operations,
    parts,
  };
}

function lowerEntityPart(
  part: EntityPart,
  agg: Aggregate,
  outer: Env,
): EntityPartIR {
  const inner = inPart(outer, agg, part);
  const props = part.members.filter(isProperty) as Property[];
  return {
    name: part.name,
    parentName: agg.name,
    parentIdValueType: (agg.idKind ?? "guid") as IdValueType,
    fields: props.map(lowerField),
    contains: part.members.filter(isContainment).map(lowerContainment),
    derived: part.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner)),
    invariants: part.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
    functions: part.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

function lowerRepository(repo: Repository): RepositoryIR {
  return {
    name: repo.name,
    aggregateName: repo.aggregate?.ref?.name ?? "Unknown",
    finds: repo.finds.map((f) => ({
      name: f.name,
      params: f.params.map((p) => ({ name: p.name, type: lowerType(p.type) })),
      returnType: lowerType(f.returnType),
    })),
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function lowerField(p: Property): FieldIR {
  return {
    name: p.name,
    type: lowerType(p.type),
    optional: !!p.type?.optional,
  };
}

function lowerContainment(c: import("../language/generated/ast.js").Containment): ContainmentIR {
  return {
    name: c.name,
    partName: c.partType?.ref?.name ?? "Unknown",
    collection: !!c.collection,
  };
}

function lowerDerived(d: import("../language/generated/ast.js").DerivedProp, env: Env): DerivedIR {
  return {
    name: d.name,
    type: lowerType(d.type),
    expr: lowerExpr(d.expr, env),
  };
}

function lowerInvariant(i: import("../language/generated/ast.js").Invariant, env: Env): InvariantIR {
  return {
    expr: lowerExpr(i.expr, env),
    guard: i.guard ? lowerExpr(i.guard, env) : undefined,
    source: cstText(i.expr),
  };
}

function lowerFunction(f: FunctionDecl, env: Env): FunctionIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of f.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  return {
    name: f.name,
    params,
    returnType: lowerType(f.returnType),
    body: lowerExpr(f.body, inner),
  };
}

function lowerOperation(op: Operation, env: Env): OperationIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of op.params) {
    const t = lowerType(p.type);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  const stmts: StmtIR[] = [];
  for (const s of op.body) {
    const result = lowerStatement(s, inner);
    stmts.push(result.stmt);
    inner = result.envAfter;
  }
  return {
    name: op.name,
    visibility: op.private ? "private" : "public",
    params,
    statements: stmts,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function lowerType(t: TypeRef | undefined): TypeIR {
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

function lowerStatement(stmt: Statement, env: Env): { stmt: StmtIR; envAfter: Env } {
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
    const lv = stmt.target;
    if (!stmt.op) {
      if (lv.call && lv.tail.length === 0) {
        const fn = findFunctionInEnv(env, lv.head);
        void fn; // op resolution happens in resolveCallKind for IR consumers
        const args = (lv.args ?? []).map((a) => lowerExpr(a, env));
        const target: "function" | "private-operation" = fn
          ? "function"
          : "private-operation";
        return {
          stmt: { kind: "call", target, name: lv.head, args },
          envAfter: env,
        };
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

// Need to reach LValue without circular import
type Lvalue = LValue;
function lvFromAssignOrCall(s: { target: Lvalue }): Lvalue {
  return s.target;
}
// Actually use the parser's LValue inline:
const _ignore = lvFromAssignOrCall; // keep TS happy

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function lowerExpr(expr: Expression | undefined, env: Env): ExprIR {
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
      if (isContainment(m as never) && (m as { name: string }).name === name) {
        const c = m as import("../language/generated/ast.js").Containment;
        const partName = c.partType?.ref?.name ?? "Unknown";
        const t: TypeIR = c.collection
          ? { kind: "array", element: { kind: "entity", name: partName } }
          : { kind: "entity", name: partName };
        return { kind: "ref", name, refKind: "this-prop", type: t };
      }
      if (isDerivedProp(m as never) && (m as { name: string }).name === name) {
        const d = m as import("../language/generated/ast.js").DerivedProp;
        return {
          kind: "ref",
          name,
          refKind: "this-derived",
          type: lowerType(d.type),
        };
      }
      if (isFunctionDecl(m) && m.name === name) {
        return { kind: "ref", name, refKind: "helper-fn" };
      }
    }
  }
  // Enum value lookup
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
  return { kind: "ref", name, refKind: "unknown" };
}

function resolveCallKind(name: string, env: Env): "function" | "value-object-ctor" | "private-operation" | "free" {
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
      if ((isAggregate(o) || isEntityPart(o)) && isOperation(m as never) && (m as Operation).name === name) {
        return "private-operation";
      }
    }
  }
  // Value-object constructor
  for (const m of env.ctx.members) {
    if (isValueObject(m) && m.name === name) return "value-object-ctor";
  }
  return "free";
}

// ---------------------------------------------------------------------------
// Type inference for expressions (best-effort, used to inform IR nodes)
// ---------------------------------------------------------------------------

function inferExprType(expr: Expression | undefined, env: Env): TypeIR {
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
    if (op === "&&" || op === "||" || op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
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
    return memberType(recvType, expr.member, env, expr.args.length);
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
    const ai = order.indexOf(a.name as never);
    const bi = order.indexOf(b.name as never);
    if (ai >= 0 && bi >= 0) return { kind: "primitive", name: order[Math.max(ai, bi)]! };
  }
  return a;
}

function memberType(t: TypeIR, name: string, env: Env, _argCount: number): TypeIR {
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
    if (isContainment(m as never) && (m as { name: string }).name === name) {
      const c = m as import("../language/generated/ast.js").Containment;
      const partName = c.partType?.ref?.name ?? "Unknown";
      return c.collection
        ? { kind: "array", element: { kind: "entity", name: partName } }
        : { kind: "entity", name: partName };
    }
    if (isDerivedProp(m as never) && (m as { name: string }).name === name) {
      return lowerType((m as import("../language/generated/ast.js").DerivedProp).type);
    }
  }
  return { kind: "primitive", name: "string" };
}

function memberOnValueObject(vo: ValueObject, name: string): TypeIR {
  for (const m of vo.members) {
    if (isProperty(m) && m.name === name) return lowerType(m.type);
    if (isDerivedProp(m as never) && (m as { name: string }).name === name) {
      return lowerType((m as import("../language/generated/ast.js").DerivedProp).type);
    }
  }
  return { kind: "primitive", name: "string" };
}

function findEntityByName(env: Env, name: string): Aggregate | EntityPart | undefined {
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
  for (const m of env.ctx.members) {
    if (isValueObject(m) && m.name === name) return m;
  }
  return undefined;
}

function findFunctionInEnv(env: Env, name: string): FunctionDecl | undefined {
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

function findOperationInEnv(env: Env, name: string): Operation | undefined {
  if (!env.aggregate) return undefined;
  for (const m of env.aggregate.members) {
    if (isOperation(m as never) && (m as Operation).name === name) return m as Operation;
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
// Misc
// ---------------------------------------------------------------------------

function ancestorAggregate(node: AstNode): Aggregate | undefined {
  let cur: AstNode | undefined = node;
  while (cur) {
    if (isAggregate(cur)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

function cstText(expr: Expression | undefined): string {
  if (!expr) return "";
  const cst = (expr as { $cstNode?: { text?: string } }).$cstNode;
  return cst?.text ?? "<expr>";
}
