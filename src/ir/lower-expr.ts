import type { AstNode } from "langium";
import { AstUtils } from "langium";
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
  Property,
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
  isMatchExpr,
  isMemberAccess,
  isNamedType,
  isNameRef,
  isNewExpr,
  isNowExpr,
  isNullLit,
  isObjectLit,
  isOperation,
  isParenExpr,
  isPreconditionStmt,
  isPrimitiveType,
  isProperty,
  isRequiresStmt,
  isStringLit,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
} from "../language/generated/ast.js";
import { isCollectionOp, isIntrinsicMatcher } from "../language/type-system.js";
import type {
  ExprIR,
  IdValueType,
  PathIR,
  PermissionDeclIR,
  ProvSite,
  StmtIR,
  TypeIR,
  UserIR,
} from "./loom-ir.js";
import { lit } from "./loom-ir.js";
import { snapshotIdFor } from "./prov-id.js";

/** Synthetic entity name used to type the `currentUser` magic
 *  identifier.  Member access on the user shape resolves through
 *  `env.user.fields` rather than the bounded-context namespace, so
 *  the name doesn't collide with any user-declared aggregate / part. */
export const USER_SHAPE_NAME = "__User__";

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
  /** System-wide user-claim shape — the lowered `user { ... }` block.
   *  Threaded down by the lowering structure layer so every
   *  expression context (operation / workflow / view / test) can
   *  resolve the magic `currentUser` identifier.  Undefined for
   *  systems / loose contexts that don't declare a user block. */
  user?: UserIR;
  /** Module-scoped permission catalogue — populated when the
   *  enclosing context lives inside a module that declares one or
   *  more `permissions { ... }` blocks.  Drives resolution of the
   *  magic `permissions.<name>` identifier in expression bodies.
   *  Loose contexts (no enclosing module) leave it undefined; the
   *  validator surfaces a friendly diagnostic for any
   *  `permissions.X` reference there. */
  modulePermissions?: PermissionDeclIR[];
}

export function newEnv(
  ctx: BoundedContext,
  user?: UserIR,
  modulePermissions?: PermissionDeclIR[],
): Env {
  return { ctx, locals: new Map(), user, modulePermissions };
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

export interface ScopeCandidate {
  name: string;
  kind:
    | "current-user"
    | "param"
    | "let"
    | "lambda"
    | "property"
    | "derived"
    | "helper-fn"
    | "enum-value";
}

/** Enumerate the names resolvable as a bare `NameRef` in `env` — the
 *  enumeration counterpart to `resolveNameRef` below.  Drives scope-aware name
 *  suggestions in tooling (the web model builder's expression editor) so the
 *  in-scope rules live in one place.  Order follows resolution precedence
 *  (currentUser → locals → properties/containments/derived/helpers → enum
 *  values); the first occurrence of a name wins, mirroring shadowing. */
export function inScopeNames(env: Env): ScopeCandidate[] {
  const out: ScopeCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: ScopeCandidate["kind"]): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, kind });
  };
  if (env.user) add("currentUser", "current-user");
  for (const [name, info] of env.locals) add(name, info.kind);
  const owner = env.part ?? env.aggregate ?? env.valueObject;
  if (owner) {
    for (const m of owner.members) {
      if (isProperty(m) || isContainment(m)) add(m.name, "property");
      else if (isDerivedProp(m)) add(m.name, "derived");
      else if (isFunctionDecl(m)) add(m.name, "helper-fn");
    }
  }
  if (env.ctx) {
    for (const m of env.ctx.members) {
      if (isEnumDecl(m)) for (const v of m.values) add(v.name, "enum-value");
    }
  }
  return out;
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

export function lowerStatement(stmt: Statement, env: Env): { stmt: StmtIR; envAfter: Env } {
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
  if (isRequiresStmt(stmt)) {
    // `requires` lowers like `precondition` but with a different
    // statement kind so the renderer can throw a 403-mapping
    // exception instead of the 400-mapping DomainException.
    return {
      stmt: {
        kind: "requires",
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
        const target: "function" | "private-operation" = fn ? "function" : "private-operation";
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
    const prov = provSiteFor(path, stmt.value, stmt, env);
    if (stmt.op === ":=") {
      const targetType = pathType(path, env);
      return {
        stmt: { kind: "assign", target: path, value, targetType, prov },
        envAfter: env,
      };
    }
    if (stmt.op === "+=" || stmt.op === "-=") {
      const targetType = pathType(path, env);
      const elementType = targetType.kind === "array" ? targetType.element : targetType;
      return {
        stmt: {
          kind: stmt.op === "+=" ? "add" : "remove",
          target: path,
          value,
          elementType,
          prov,
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
    // Lambdas can carry either a single expression body
    // (`x => expr`, the only v22 form) OR a brace-block of statements
    // (`x => { stmt; stmt; … }`, new for page event handlers).  The
    // grammar rule sets `body` xor `stmts`; we mirror that in the IR.
    if (expr.body) {
      return {
        kind: "lambda",
        param: expr.param,
        body: lowerExpr(expr.body, inner),
      };
    }
    // Block bodies thread the lambda-local env through each statement
    // so a `let` in stmt N is visible in stmt N+1.  Statements inside
    // a lambda block stay typed against the existing `Statement` /
    // `StmtIR` rule — no new statement kinds needed.
    const block: StmtIR[] = [];
    let scopeEnv = inner;
    for (const s of expr.stmts ?? []) {
      const lowered = lowerStatement(s, scopeEnv);
      block.push(lowered.stmt);
      scopeEnv = lowered.envAfter;
    }
    return {
      kind: "lambda",
      param: expr.param,
      block,
    };
  }
  if (isMatchExpr(expr)) {
    // Predicate-arms expression — lowering is mechanical: each arm
    // becomes a `{ cond, value }` pair, the optional `else => expr`
    // becomes the `otherwise` slot.  Type unification across arms /
    // soundness checks are left to the validator.
    return {
      kind: "match",
      arms: expr.arms.map((arm) => ({
        cond: lowerExpr(arm.cond, env),
        value: lowerExpr(arm.value, env),
      })),
      otherwise: expr.elseExpr ? lowerExpr(expr.elseExpr, env) : undefined,
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
    // `permissions.<name>` magic identifier.  Resolves only when the
    // enclosing context belongs to a module that declared a
    // permissions catalogue; the lookup happens at lowering time so
    // the IR carries the runtime string directly (a plain string
    // literal) — no new ref kind, no per-platform render branch.
    // Non-call form only — `permissions.foo()` makes no sense and
    // falls through to the generic method-call path which will
    // surface as an unknown-method diagnostic.
    if (
      !expr.call &&
      isNameRef(expr.receiver) &&
      expr.receiver.name === "permissions" &&
      env.modulePermissions
    ) {
      const decl = env.modulePermissions.find((d) => d.name === expr.member);
      if (decl) {
        return lit("string", decl.runtimeString);
      }
      // Unknown permission name — leave the receiver unresolved so
      // the validator surfaces a clear "unknown permission" error;
      // we still produce a typed expression so downstream rendering
      // doesn't choke.
      return lit("string", `__unknown_permission__:${expr.member}`);
    }
    const recv = lowerExpr(expr.receiver, env);
    const recvType = inferExprType(expr.receiver, env);
    if (expr.call) {
      // Call args are `CallArg` nodes wrapping an
      // Expression with an optional `name:` prefix.  Lower the value
      // and capture the parallel name list; downstream consumers
      // that don't care about names see the unchanged `args`
      // shape.
      const args = expr.args.map((a) => lowerExpr(a.value, env));
      const argNames = expr.args.map((a) => a.name || undefined);
      const collectionOp = isCollectionOp(expr.member);
      return {
        kind: "method-call",
        receiver: recv,
        member: expr.member,
        args,
        receiverType: recvType,
        isCollectionOp: collectionOp,
        ...(isIntrinsicMatcher(expr.member) ? { isIntrinsicMatcher: true } : {}),
        ...(argNames.some((n) => n !== undefined) ? { argNames } : {}),
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
    const args = expr.args.map((a) => lowerExpr(a.value, env));
    const argNames = expr.args.map((a) => a.name || undefined);
    const named = argNames.some((n) => n !== undefined);
    if (isNameRef(callee)) {
      const callKind = resolveCallKind(callee.name, env);
      return {
        kind: "call",
        callKind,
        name: callee.name,
        args,
        ...(named ? { argNames } : {}),
      };
    }
    return {
      kind: "call",
      callKind: "free",
      name: "<expr>",
      args,
      ...(named ? { argNames } : {}),
    };
  }
  if (isNameRef(expr)) {
    return resolveNameRef(expr.name, env);
  }
  return lit("null", "null");
}

function resolveNameRef(name: string, env: Env): ExprIR {
  // `currentUser` magic identifier — resolves to a synthetic entity
  // shape backed by the system's `user { ... }` block.  Always wins
  // over locals so a let-binding can't shadow it.  When no user block
  // is declared the name falls through to ordinary local / property
  // / enum lookup so source files without auth still parse normally.
  if (name === "currentUser" && env.user) {
    return {
      kind: "ref",
      name: "currentUser",
      refKind: "current-user",
      type: { kind: "entity", name: USER_SHAPE_NAME },
    };
  }
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

export function inferExprType(expr: Expression | undefined, env: Env): TypeIR {
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
  if (isMatchExpr(expr)) {
    // Match expressions return one arm's value (or the `else`).
    // Same posture as ternary — inspect the first arm's value type;
    // soundness across arms is a validator concern (warn / error if
    // arms disagree).
    if (expr.arms.length > 0) return inferExprType(expr.arms[0]!.value, env);
    if (expr.elseExpr) return inferExprType(expr.elseExpr, env);
    // Empty match — degenerate, falls back to a string-typed
    // placeholder (same default ternary uses).  Validator reports
    // this as malformed.
    return { kind: "primitive", name: "string" };
  }
  if (isLambda(expr)) return { kind: "primitive", name: "string" };
  if (isNewExpr(expr)) {
    return { kind: "entity", name: expr.partType?.ref?.name ?? "Unknown" };
  }
  if (isMemberAccess(expr)) {
    // `permissions.<name>` always types as `string` (matches the
    // lowering, which rewrites the access to a string literal).
    if (
      !expr.call &&
      isNameRef(expr.receiver) &&
      expr.receiver.name === "permissions" &&
      env.modulePermissions
    ) {
      return { kind: "primitive", name: "string" };
    }
    // Aggregate factory: `X.create(...)` yields an `X` entity.  Without
    // this a `let order = Order.create({...})` binding types as the
    // string fallback, so subsequent member access (`order.lines`)
    // loses its element/collection shape — which, e.g., stops
    // `order.lines.count` from lowering to `.length`.  `X` is a type
    // name, not a value, so it only resolves here (not via resolveNameRef).
    if (expr.call && expr.member === "create" && isNameRef(expr.receiver)) {
      const target = findEntityByName(env, expr.receiver.name);
      if (target && isAggregate(target)) {
        return { kind: "entity", name: target.name };
      }
    }
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
  // `currentUser.<field>` — synthetic entity backed by the system's
  // user block.  Walked via env.user.fields rather than the
  // bounded-context registry.  Unknown members fall through to the
  // string fallback; the validator will surface the broken reference
  // with a friendlier message.
  if (t.kind === "entity" && t.name === USER_SHAPE_NAME && env.user) {
    const f = env.user.fields.find((f) => f.name === name);
    if (f) return f.optional ? { kind: "optional", inner: f.type } : f.type;
    return { kind: "primitive", name: "string" };
  }
  if (t.kind === "array") {
    switch (name) {
      case "count":
        return { kind: "primitive", name: "int" };
      case "sum":
        return { kind: "primitive", name: "decimal" };
      case "all":
      case "any":
      case "contains":
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
  if (t.kind === "id") {
    // `X id.member` — follow the typed reference into X's schema.
    // Mirrors the same case in `stepInto`; both `inferExprType` and
    // `lowerExpr` need it for view bind expressions to multi-hop.
    const target = findEntityByName(env, t.targetName);
    if (target) return memberOnEntity(target, name);
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

function findEntityByName(env: Env, name: string): Aggregate | EntityPart | undefined {
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

export function findFunctionInEnv(env: Env, name: string): FunctionDecl | undefined {
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

export function findOperationInEnv(env: Env, name: string): Operation | undefined {
  if (!env.aggregate) return undefined;
  for (const m of env.aggregate.members) {
    if (isOperation(m) && m.name === name) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Path typing — for assign/add/remove statements
// ---------------------------------------------------------------------------

/** Resolve the terminal stored `Property` a write path targets, for
 *  provenance instrumentation.  v1 handles direct fields on the enclosing
 *  aggregate (`field := …`, `field += …`); nested paths into value
 *  objects / parts are not instrumented yet and return undefined. */
function resolveProvenancedProperty(
  path: PathIR,
  env: Env,
): { prop: Property; type: string } | undefined {
  if (path.segments.length !== 1 || !env.aggregate) return undefined;
  const name = path.segments[0]!;
  for (const m of env.aggregate.members) {
    if (isProperty(m) && m.name === name) {
      return m.provenanced ? { prop: m, type: env.aggregate.name } : undefined;
    }
  }
  return undefined;
}

/** Build the per-site snapshot metadata for an instrumented write, or
 *  undefined when the target is not a provenanced field. */
function provSiteFor(
  path: PathIR,
  valueNode: Expression | undefined,
  stmt: AstNode,
  env: Env,
): ProvSite | undefined {
  const hit = resolveProvenancedProperty(path, env);
  if (!hit) return undefined;
  const cst = (stmt as { $cstNode?: { offset: number; length: number } }).$cstNode;
  const start = cst?.offset ?? 0;
  const span = { start, end: start + (cst?.length ?? 0) };
  const docPath = AstUtils.getDocument(stmt).uri.path;
  const exprText = cstText(valueNode);
  return {
    snapshotId: snapshotIdFor({ type: hit.type, field: hit.prop.name, exprText }),
    target: { type: hit.type, field: hit.prop.name },
    exprText,
    source: { path: docPath, span },
  };
}

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
  // Same user-shape special case as `memberType` — keeps assignment-
  // path typing (used by the validator's containing-aggregate walks)
  // consistent with the read side.  In practice paths never actually
  // step into currentUser because it's read-only, but the symmetric
  // case keeps the two functions in sync.
  if (t.kind === "entity" && t.name === USER_SHAPE_NAME && env.user) {
    const f = env.user.fields.find((f) => f.name === name);
    if (f) return f.optional ? { kind: "optional", inner: f.type } : f.type;
    return { kind: "primitive", name: "string" };
  }
  if (t.kind === "entity") {
    const target = findEntityByName(env, t.name);
    if (target) return memberOnEntity(target, name);
  }
  if (t.kind === "valueobject") {
    const vo = findValueObjectByName(env, t.name);
    if (vo) return memberOnValueObject(vo, name);
  }
  if (t.kind === "id") {
    // `customerId.name` where `customerId: Customer id` — follow the
    // typed reference into the target aggregate's schema.  Used by
    // view bind expressions to project across `X id` references
    // without an explicit join clause.  Single-hop only; the
    // resulting member type comes from the target aggregate's
    // declared shape (property / containment / derived).
    const target = findEntityByName(env, t.targetName);
    if (target) return memberOnEntity(target, name);
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
