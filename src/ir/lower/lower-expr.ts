import type { AstNode } from "langium";
import { AstUtils } from "langium";
import type {
  Aggregate,
  AggregateMember,
  BinaryChain,
  BoundedContext,
  BuilderCall,
  Criterion,
  EntityPart,
  EntityPartMember,
  Expression,
  FunctionDecl,
  LValue,
  MemberSuffix,
  Operation,
  PostfixChain,
  PostfixSuffix,
  Property,
  Statement,
  TypeRef,
  ValueObject,
} from "../../language/generated/ast.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isBinaryChain,
  isBoolLit,
  isBuilderCall,
  isCallSuffix,
  isContainment,
  isCriterion,
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
  isListLit,
  isMatchExpr,
  isMemberSuffix,
  isMoneyLit,
  isNamedType,
  isNameRef,
  isNowExpr,
  isNullLit,
  isObjectLit,
  isOperation,
  isParenExpr,
  isPostfixChain,
  isPreconditionStmt,
  isPrimitiveConversion,
  isPrimitiveType,
  isProperty,
  isRequiresStmt,
  isSlotType,
  isStringLit,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
} from "../../language/generated/ast.js";
import { isCollectionOp } from "../../util/collection-ops.js";
import { isIntrinsicMatcher } from "../../util/intrinsic-matchers.js";
import { findVerb, type ResourceVerbDef } from "../resource-verbs.js";
import type {
  ExprIR,
  IdValueType,
  PathIR,
  PermissionDeclIR,
  PrimitiveName,
  ProvSite,
  StmtIR,
  StyleIR,
  TypeIR,
  UserIR,
} from "../types/loom-ir.js";
import { lit } from "../types/loom-ir.js";
import { snapshotIdFor } from "../util/prov-id.js";
import { lowerStatement } from "./lower-stmt.js";
import {
  ancestorAggregate,
  cstText,
  type Env,
  findEntityByName,
  findFunctionInEnv,
  findValueObjectByName,
  inAggregate,
  lowerType,
  USER_SHAPE_NAME,
  withLocal,
} from "./lower-types.js";

/** Synthetic entity name used to type the `currentUser` magic
 *  identifier.  Member access on the user shape resolves through
 *  `env.user.fields` rather than the bounded-context namespace, so
 *  the name doesn't collide with any user-declared aggregate / part. */

/** Synthetic entity name used to type an ambient resource handle.  A
 *  `.verb(...)` call on a ref of this type lowers to a `resource-op`;
 *  the name carries no members of its own (Phase 4). */
const RESOURCE_HANDLE_SHAPE = "__ResourceHandle";

/** Map a resource verb's declared result to a `TypeIR`.  `json`/`json?`
 *  → the `json` primitive (optional wrapped); `void`/unknown → a string
 *  placeholder (the value is unused at a void call site). */
function verbResultType(verbDef: ResourceVerbDef | undefined): TypeIR {
  if (!verbDef) return { kind: "primitive", name: "string" };
  switch (verbDef.result) {
    case "json":
      return { kind: "primitive", name: "json" };
    case "json?":
      return { kind: "optional", inner: { kind: "primitive", name: "json" } };
    case "string":
      return { kind: "primitive", name: "string" };
    case "string[]":
      return { kind: "array", element: { kind: "primitive", name: "string" } };
    default:
      return { kind: "primitive", name: "string" };
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** Per-fold-step money / literal promotion for a binary chain.  When one
 *  operand is typed as long / decimal / money, the other operand's bare
 *  numeric literal is rewritten to that operand's literal IR kind so the
 *  binary node's IR metadata stays type-honest and backends emit the
 *  right form.  Promotions are one-sided: a typed VALUE never promotes —
 *  the strict gate (#506) governs that. */
function promoteMoneyOperands(
  op: string,
  leftIR: ExprIR,
  leftType: TypeIR,
  rightIR: ExprIR,
  rightType: TypeIR,
  rightExpr: Expression,
  leftExprForPromotion: Expression | undefined,
  env: Env,
): { leftIR: ExprIR; leftType: TypeIR; rightIR: ExprIR; rightType: TypeIR } {
  let outLeft = leftIR;
  let outLeftT = leftType;
  let outRight = rightIR;
  let outRightT = rightType;
  const lAnchor = literalPromotionAnchor(leftType);
  const rAnchor = literalPromotionAnchor(rightType);
  if (lAnchor) {
    const promoted = tryPromoteNumericLit(rightExpr, lAnchor);
    if (promoted) {
      outRight = promoted;
      outRightT = { kind: "primitive", name: lAnchor };
    }
  }
  if (rAnchor && leftExprForPromotion) {
    const promoted = tryPromoteNumericLit(leftExprForPromotion, rAnchor);
    if (promoted) {
      outLeft = promoted;
      outLeftT = { kind: "primitive", name: rAnchor };
    }
  }
  // Implicit `string + X` concat: wrap the non-string operand in a
  // `convert` IR so backends emit `String(x)` / `x.ToString()` /
  // `to_string(x)` per their existing renderConvert dispatch —
  // identical to what the explicit `string(x)` form would produce.
  if (op === "+") {
    const lStr = outLeftT.kind === "primitive" && outLeftT.name === "string";
    const rStr = outRightT.kind === "primitive" && outRightT.name === "string";
    if (lStr && !rStr && isImplicitlyStringifiableIR(outRightT, env)) {
      outRight = wrapForStringConcat(outRight, outRightT);
      outRightT = { kind: "primitive", name: "string" };
    } else if (rStr && !lStr && isImplicitlyStringifiableIR(outLeftT, env)) {
      outLeft = wrapForStringConcat(outLeft, outLeftT);
      outLeftT = { kind: "primitive", name: "string" };
    }
  }
  return { leftIR: outLeft, leftType: outLeftT, rightIR: outRight, rightType: outRightT };
}

/** Pure left-fold of a flat BinaryChain.  Each fold-step applies the
 *  money / literal promotion (mirrors the validator) and produces a
 *  binary IR node with its metadata fully populated. */
function lowerBinaryChain(chain: BinaryChain, env: Env): ExprIR {
  let acc = lowerExpr(chain.head, env);
  let accType = inferExprType(chain.head, env);
  // Only the head operand corresponds to a single AST node usable for
  // literal-promotion lookup against a right-side anchor.  After the
  // first fold-step `acc` is a synthetic binary IR node — no
  // backing AST literal — so subsequent steps only promote the rhs.
  let headExprForPromotion: Expression | undefined = chain.head;
  for (let i = 0; i < chain.ops.length; i++) {
    const op = chain.ops[i]!;
    const rhsExpr = chain.rest[i]!;
    let rhsIR = lowerExpr(rhsExpr, env);
    let rhsType = inferExprType(rhsExpr, env);
    const promoted = promoteMoneyOperands(
      op,
      acc,
      accType,
      rhsIR,
      rhsType,
      rhsExpr,
      headExprForPromotion,
      env,
    );
    acc = promoted.leftIR;
    accType = promoted.leftType;
    rhsIR = promoted.rightIR;
    rhsType = promoted.rightType;
    const resultType = binaryResultType(op, accType, rhsType);
    acc = {
      kind: "binary",
      op,
      left: acc,
      right: rhsIR,
      leftType: accType,
      resultType,
    };
    accType = resultType;
    // After the first fold-step the lhs is a synthetic node — no AST
    // literal to promote on the next step.
    headExprForPromotion = undefined;
  }
  return acc;
}

/** Walk a PostfixChain's suffixes left-to-right, lowering each to its
 *  IR shape.  Handles two probes that fire only when the head + first
 *  suffix together form a magic pattern: `permissions.<name>` (rewrites
 *  to a string literal) and `Aggregate.create(...)` (factory call). */
function lowerPostfixChain(chain: PostfixChain, env: Env): ExprIR {
  // Probe: `permissions.<name>` — first suffix is a non-call MemberSuffix
  // and the head is a `NameRef("permissions")`, and the enclosing
  // module declared a permissions catalogue.  Rewrites to a plain
  // string literal carrying the resolved runtime string.
  const first = chain.suffixes[0];
  if (
    first &&
    isMemberSuffix(first) &&
    !first.call &&
    isNameRef(chain.head) &&
    chain.head.name === "permissions" &&
    env.modulePermissions
  ) {
    const decl = env.modulePermissions.find((d) => d.name === first.member);
    let permIR: ExprIR;
    if (decl) {
      permIR = lit("string", decl.runtimeString);
    } else {
      // Unknown permission name — leave a sentinel string so the
      // validator surfaces a clear diagnostic; downstream rendering
      // still has a typed expression.
      permIR = lit("string", `__unknown_permission__:${first.member}`);
    }
    let recv = permIR;
    let recvType: TypeIR = { kind: "primitive", name: "string" };
    for (let i = 1; i < chain.suffixes.length; i++) {
      const out = applySuffixToRecv(recv, recvType, chain.suffixes[i]!, env);
      recv = out.recv;
      recvType = out.recvType;
    }
    return recv;
  }
  let recv = lowerExpr(chain.head, env);
  let recvType = inferExprType(chain.head, env);
  for (const s of chain.suffixes) {
    const out = applySuffixToRecv(recv, recvType, s, env);
    recv = out.recv;
    recvType = out.recvType;
  }
  return recv;
}

/** Apply one postfix suffix to a receiver IR + type — `MemberSuffix`
 *  becomes either a `member` (no call) or `method-call` IR; `CallSuffix`
 *  collapses the receiver into a free / function / VO-ctor `call` IR
 *  when the receiver is a bare `NameRef`, otherwise a `<expr>` call. */
function applySuffixToRecv(
  recv: ExprIR,
  recvType: TypeIR,
  suffix: PostfixSuffix,
  env: Env,
): { recv: ExprIR; recvType: TypeIR } {
  if (isCallSuffix(suffix)) {
    // Hoist `style:` named arg the same way builder-call form does, so
    // both `Container { style: {...}, ... }` and `Container(style: {...}, ...)`
    // surface the same IR shape downstream.
    const styleHoist = hoistStyleArg(suffix.args, env);
    const callArgs = styleHoist.remainingEntries;
    const args = callArgs.map((a) => lowerExpr(a.value, env));
    const argNames = callArgs.map((a) => a.name || undefined);
    const named = argNames.some((n) => n !== undefined);
    // When the receiver IR is a `ref` (we lowered a bare NameRef
    // head), produce the same `call` IR the old CallExpr branch did;
    // resolution of callKind matches the original semantics.
    if (recv.kind === "ref") {
      // Parameterised criterion call (`InRegion("EU")`) — inline the
      // predicate body with the call arguments substituted for its
      // parameters.  Produces an ordinary boolean expression.
      const crit = findCriterionInEnv(env, recv.name);
      if (crit) {
        return {
          recv: inlineCriterion(crit, args, env),
          recvType: { kind: "primitive", name: "bool" },
        };
      }
      const callKind = resolveCallKind(recv.name, env);
      const callIR: ExprIR = {
        kind: "call",
        callKind,
        name: recv.name,
        args,
        ...(named ? { argNames } : {}),
        ...(styleHoist.style ? { style: styleHoist.style } : {}),
      };
      // Result type best-effort — a function returns its declared type,
      // a value-object ctor returns the VO, everything else falls
      // back to a string placeholder (matches the legacy inferExprType).
      let resultType: TypeIR = { kind: "primitive", name: "string" };
      const fn = findFunctionInEnv(env, recv.name);
      if (fn) resultType = lowerType(fn.returnType);
      else {
        const vo = findValueObjectByName(env, recv.name);
        if (vo) resultType = { kind: "valueobject", name: vo.name };
      }
      return { recv: callIR, recvType: resultType };
    }
    const callIR: ExprIR = {
      kind: "call",
      callKind: "free",
      name: "<expr>",
      args,
      ...(named ? { argNames } : {}),
      ...(styleHoist.style ? { style: styleHoist.style } : {}),
    };
    return { recv: callIR, recvType: { kind: "primitive", name: "string" } };
  }
  // MemberSuffix
  const ms = suffix as MemberSuffix;
  if (ms.call) {
    const args = ms.args.map((a) => lowerExpr(a.value, env));
    const argNames = ms.args.map((a) => a.name || undefined);
    // `<resource>.<verb>(args)` — a verb call on an ambient resource
    // handle lowers to a `resource-op` call (Phase 4).  The verb's
    // capability comes from the resource-verb registry; an unknown verb
    // still lowers (carrying the raw name) so the IR validator can emit
    // a precise diagnostic rather than the lowering silently dropping it.
    if (recv.kind === "ref" && recv.refKind === "resource" && recv.resourceKind) {
      const verbDef = findVerb(recv.resourceKind, ms.member);
      const callIR: ExprIR = {
        kind: "call",
        callKind: "resource-op",
        name: ms.member,
        args,
        ...(argNames.some((n) => n !== undefined) ? { argNames } : {}),
        resourceOp: {
          resourceName: recv.resourceName ?? recv.name,
          resourceKind: recv.resourceKind,
          verb: ms.member,
          capability: verbDef?.capability ?? "",
        },
      };
      const resultType = verbResultType(verbDef);
      return { recv: callIR, recvType: resultType };
    }
    const collectionOp = isCollectionOp(ms.member);
    const mcIR: ExprIR = {
      kind: "method-call",
      receiver: recv,
      member: ms.member,
      args,
      receiverType: recvType,
      isCollectionOp: collectionOp,
      ...(isIntrinsicMatcher(ms.member) ? { isIntrinsicMatcher: true } : {}),
      ...(argNames.some((n) => n !== undefined) ? { argNames } : {}),
    };
    // Result type after a method call — `memberType` handles collection
    // ops, entity/VO members, and the string `.length` case.
    const nextType = memberType(recvType, ms.member, env);
    return { recv: mcIR, recvType: nextType };
  }
  // Non-call MemberSuffix — preserve `stepInto` semantics on the IR
  // node's `memberType` (matches the legacy MemberAccess lowering),
  // but track the next type using `memberType` so chained access
  // through array.count etc. continues to type correctly.
  const stepType = stepInto(recvType, ms.member, env);
  const memberIR: ExprIR = {
    kind: "member",
    receiver: recv,
    member: ms.member,
    receiverType: recvType,
    memberType: stepType,
  };
  return { recv: memberIR, recvType: memberType(recvType, ms.member, env) };
}

export function lowerExpr(expr: Expression | undefined, env: Env): ExprIR {
  if (!expr) return lit("null", "null");
  if (isStringLit(expr)) return lit("string", expr.value);
  if (isIntLit(expr)) return lit("int", String(expr.value));
  if (isDecLit(expr)) return lit("decimal", expr.value);
  if (isMoneyLit(expr)) return lit("money", expr.value ?? "0");
  if (isPrimitiveConversion(expr)) {
    const fromType = inferExprType(expr.value, env);
    // Aggregate → string lowers to `aggregate.display` member access.
    // The validator has already ensured `display` exists; if it
    // didn't, lowering still produces a member access that backends
    // would emit but the validator's diagnostic blocks the build.
    if (
      expr.target === "string" &&
      fromType.kind === "entity" &&
      entityHasDisplay(fromType.name, env)
    ) {
      return {
        kind: "member",
        receiver: lowerExpr(expr.value, env),
        member: "display",
        receiverType: fromType,
        memberType: { kind: "primitive", name: "string" },
      };
    }
    const from = fromType.kind === "primitive" ? (fromType.name as PrimitiveName) : undefined;
    return {
      kind: "convert",
      target: expr.target as PrimitiveName,
      from,
      value: lowerExpr(expr.value, env),
    };
  }
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
  if (isBinaryChain(expr)) {
    return lowerBinaryChain(expr, env);
  }
  if (isTernaryExpr(expr)) {
    return {
      kind: "ternary",
      cond: lowerExpr(expr.cond, env),
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
  if (isListLit(expr)) {
    return {
      kind: "list",
      elements: (expr.elements ?? []).map((e) => lowerExpr(e, env)),
    };
  }
  if (isBuilderCall(expr)) {
    return lowerBuilderCall(expr, env);
  }
  if (isPostfixChain(expr)) {
    return lowerPostfixChain(expr, env);
  }
  if (isNameRef(expr)) {
    return resolveNameRef(expr.name, env);
  }
  return lit("null", "null");
}

/** Lower a v2 BuilderCall (`Type { slot: value, ... }`).  The type name
 *  resolves at lowering time against the in-scope declarations:
 *    - ValueObject       → "call" IR (callKind "value-object-ctor")
 *    - EntityPart        → "new" IR (part construction)
 *    - Anything else     → "call" IR (callKind "free") — walker
 *      primitives, user components, unknown names.  The walker
 *      dispatches by name on the resulting CallIR. */
function lowerBuilderCall(expr: BuilderCall, env: Env): ExprIR {
  const name = expr.type;
  const vo = findValueObjectByName(env, name);
  if (vo) {
    return lowerBuilderCallAsCall(expr, env, name, "value-object-ctor");
  }
  const ent = findEntityByName(env, name);
  if (ent && isEntityPart(ent)) {
    const fields = expr.entries
      .filter((e) => e.name !== undefined)
      .map((e) => ({
        name: e.name as string,
        value: lowerExpr(e.value, env),
      }));
    return { kind: "new", partName: name, fields };
  }
  return lowerBuilderCallAsCall(expr, env, name, "free");
}

function inferBuilderCallType(expr: BuilderCall, env: Env): TypeIR {
  const name = expr.type;
  const vo = findValueObjectByName(env, name);
  if (vo) return { kind: "valueobject", name };
  const ent = findEntityByName(env, name);
  if (ent) return { kind: "entity", name };
  return { kind: "entity", name };
}

function lowerBuilderCallAsCall(
  expr: BuilderCall,
  env: Env,
  name: string,
  callKind: "value-object-ctor" | "free",
): ExprIR {
  // Hoist `style:` named arg into its own IR field — see lowerStyleArg.
  // Filtering happens by index so `args` and `argNames` stay parallel.
  const styleHoist = hoistStyleArg(expr.entries, env);
  const entries = styleHoist.remainingEntries;
  const args = entries.map((e) => lowerExpr(e.value, env));
  const argNames = entries.map((e) => e.name || undefined);
  const named = argNames.some((n) => n !== undefined);
  return {
    kind: "call",
    callKind,
    name,
    args,
    ...(named ? { argNames } : {}),
    ...(styleHoist.style ? { style: styleHoist.style } : {}),
  };
}

/** Hoist a `style: { … }` named entry out of a list of BuilderEntries
 *  or CallArgs.  Returns the remaining entries (parallel to the
 *  source order) plus a `StyleIR` when present.  When `style:` is
 *  present but its value isn't an object literal, the entry is
 *  dropped silently (validator surfaces a clearer diagnostic) so
 *  downstream rendering doesn't see a half-broken shape. */
function hoistStyleArg<E extends { name?: string; value: Expression }>(
  entries: ReadonlyArray<E>,
  env: Env,
): { remainingEntries: E[]; style?: StyleIR } {
  let style: StyleIR | undefined;
  const remaining: E[] = [];
  for (const e of entries) {
    if (e.name === "style" && isObjectLit(e.value)) {
      style = {
        entries: e.value.fields.map((f) => ({
          key: f.name,
          value: lowerExpr(f.value, env),
        })),
      };
      continue;
    }
    remaining.push(e);
  }
  return { remainingEntries: remaining, style };
}

/** Locate a `criterion` declaration by name in the enclosing context. */
function findCriterionInEnv(env: Env, name: string): Criterion | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isCriterion(m) && m.name === name) return m;
  }
  return undefined;
}

/** Inline a criterion reference into the host expression.  Re-lowers the
 *  predicate body in a scope whose candidate is the criterion's `of <T>`
 *  aggregate (so the body's bare field names / `this` rebind to the host
 *  receiver) and whose parameters are substituted by the caller's
 *  already-lowered argument expressions.  Composition (`A && B`) needs no
 *  special handling — it is ordinary boolean operators over inlined
 *  predicates, so the result flows through the same expression→SQL path a
 *  hand-written inline filter does.  A reference cycle is broken by
 *  leaving the inner reference unresolved; `loom.criterion-cycle` reports
 *  it. */
function inlineCriterion(c: Criterion, args: ExprIR[], env: Env): ExprIR {
  const stack = env.criterionStack ?? [];
  if (stack.includes(c.name)) {
    return { kind: "ref", name: c.name, refKind: "unknown" };
  }
  // The body sees only the candidate + its own parameters: start from a
  // fresh local scope but keep ctx / user / module-permissions so
  // `currentUser`, enum values, and sibling criteria still resolve.
  let bodyEnv: Env = { ...env, locals: new Map(), criterionArgs: undefined };
  const targetType = lowerType(c.target);
  if (targetType.kind === "entity") {
    const candidate = findEntityByName(env, targetType.name);
    if (candidate && isAggregate(candidate)) bodyEnv = inAggregate(bodyEnv, candidate);
  }
  const argMap = new Map<string, ExprIR>();
  c.params.forEach((p, i) => {
    const a = args[i];
    if (a) argMap.set(p.name, a);
  });
  bodyEnv = { ...bodyEnv, criterionArgs: argMap, criterionStack: [...stack, c.name] };
  return lowerExpr(c.body, bodyEnv);
}

function resolveNameRef(name: string, env: Env): ExprIR {
  // Criterion-parameter substitution — while inlining a criterion body, a
  // bare reference to one of its parameters resolves to the caller's
  // already-lowered argument expression.  Wins over candidate fields so a
  // parameter shadows a field of the same name (matches function-body
  // parameter scoping).
  if (env.criterionArgs?.has(name)) {
    return env.criterionArgs.get(name) as ExprIR;
  }
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
  // Ambient resource handle (`files`, `jobs`, …) — a `resource X { for:
  // <thisCtx>, … }` declaration in scope (Phase 4).  Resolved before
  // locals so it isn't shadowable, mirroring `currentUser`.  The type is
  // a synthetic marker; a `.verb(...)` call on this ref lowers to a
  // `resource-op` (see `applySuffixToRecv`).
  const resourceKind = env.resources?.get(name);
  if (resourceKind) {
    return {
      kind: "ref",
      name,
      refKind: "resource",
      resourceName: name,
      resourceKind,
      type: { kind: "entity", name: RESOURCE_HANDLE_SHAPE },
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
  // Parameterless criterion reference — inline the predicate body.  A
  // parameterised criterion referenced bare (no argument list) falls
  // through to the unresolved path; the validator reports the arity
  // mismatch (`loom.criterion-arity`).
  {
    const crit = findCriterionInEnv(env, name);
    if (crit && crit.params.length === 0) {
      return inlineCriterion(crit, [], env);
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
  if (isMoneyLit(expr)) return { kind: "primitive", name: "money" };
  if (isPrimitiveConversion(expr)) {
    return { kind: "primitive", name: expr.target as PrimitiveName };
  }
  if (isBoolLit(expr)) return { kind: "primitive", name: "bool" };
  if (isNullLit(expr)) return { kind: "primitive", name: "string" };
  if (isListLit(expr)) {
    // Best-effort element-type inference: use the first element's type
    // as the array's element type.  Empty list / heterogeneous lists
    // fall back to `string` element — consumers that care (e.g. the
    // walker's `cols:` reader) inspect element kinds directly off
    // the IR rather than relying on this approximation.
    const first = expr.elements?.[0];
    const elementType: TypeIR = first
      ? inferExprType(first, env)
      : { kind: "primitive", name: "string" };
    return { kind: "array", element: elementType };
  }
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
  if (isBinaryChain(expr)) {
    // Left-fold the chain's operator types, mirroring lowerBinaryChain.
    // Any boolean-typed op short-circuits the whole chain — once you
    // see a logical / comparison op the result is bool regardless of
    // subsequent ops (the chain is homogeneous-op per precedence
    // level, so this is just an early exit).
    let acc = inferExprType(expr.head, env);
    for (let i = 0; i < expr.ops.length; i++) {
      const op = expr.ops[i]!;
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
      const rhs = inferExprType(expr.rest[i]!, env);
      acc = binaryResultType(op, acc, rhs);
    }
    return acc;
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
  if (isBuilderCall(expr)) {
    return inferBuilderCallType(expr, env);
  }
  if (isPostfixChain(expr)) {
    // Probe: `permissions.<name>` always types as string.
    const first = expr.suffixes[0];
    if (
      first &&
      isMemberSuffix(first) &&
      !first.call &&
      isNameRef(expr.head) &&
      expr.head.name === "permissions" &&
      env.modulePermissions
    ) {
      let curType: TypeIR = { kind: "primitive", name: "string" };
      for (let i = 1; i < expr.suffixes.length; i++) {
        curType = inferSuffixType(curType, expr.suffixes[i]!, env);
      }
      return curType;
    }
    // Probe: `Aggregate.create(...)` factory — head is `NameRef`
    // pointing at an aggregate, first suffix is a call MemberSuffix
    // with member==="create".  Result is the aggregate entity type.
    let curType: TypeIR;
    if (
      first &&
      isMemberSuffix(first) &&
      first.call &&
      first.member === "create" &&
      isNameRef(expr.head)
    ) {
      const target = findEntityByName(env, expr.head.name);
      if (target && isAggregate(target)) {
        curType = { kind: "entity", name: target.name };
        for (let i = 1; i < expr.suffixes.length; i++) {
          curType = inferSuffixType(curType, expr.suffixes[i]!, env);
        }
        return curType;
      }
    }
    curType = inferExprType(expr.head, env);
    // Free-call collapse: head is NameRef and first suffix is CallSuffix
    // — the result type is the function's return type / VO type, then
    // we walk remaining suffixes.
    if (first && isCallSuffix(first) && isNameRef(expr.head)) {
      // Criterion call (`InRegion("EU")`) types as a boolean predicate.
      if (findCriterionInEnv(env, expr.head.name)) {
        curType = { kind: "primitive", name: "bool" };
        for (let i = 1; i < expr.suffixes.length; i++) {
          curType = inferSuffixType(curType, expr.suffixes[i]!, env);
        }
        return curType;
      }
      const fn = findFunctionInEnv(env, expr.head.name);
      if (fn) curType = lowerType(fn.returnType);
      else {
        const vo = findValueObjectByName(env, expr.head.name);
        if (vo) curType = { kind: "valueobject", name: vo.name };
        else curType = { kind: "primitive", name: "string" };
      }
      for (let i = 1; i < expr.suffixes.length; i++) {
        curType = inferSuffixType(curType, expr.suffixes[i]!, env);
      }
      return curType;
    }
    for (const s of expr.suffixes) {
      curType = inferSuffixType(curType, s, env);
    }
    return curType;
  }
  if (isNameRef(expr)) {
    // Criterion-parameter substitution — type of the bound argument.
    const arg = env.criterionArgs?.get(expr.name);
    if (arg) return "type" in arg && arg.type ? arg.type : { kind: "primitive", name: "string" };
    // Parameterless criterion reference types as a boolean predicate.
    const crit = findCriterionInEnv(env, expr.name);
    if (crit && crit.params.length === 0) return { kind: "primitive", name: "bool" };
    const ref = resolveNameRef(expr.name, env);
    if (ref.kind === "ref" && ref.type) return ref.type;
    return { kind: "primitive", name: "string" };
  }
  return { kind: "primitive", name: "string" };
}

/**
 * IR-layer mirror of `type-system.ts`'s `arithmeticResult`/comparison
 * logic, but operating on `TypeIR` and dispatching on the operator.
 *
 * Used to populate `leftType`/`resultType` on binary IR nodes so
 * backends never re-run expression-type inference.  Rules:
 *   • Logical (`&&`, `||`) and comparison (`==` `!=` `<` `<=` `>` `>=`)
 *     → primitive bool, regardless of operand types.
 *   • Arithmetic with money operands is closed: `money ± money =
 *     money`, `money × {int|long|decimal} = money` (commutative),
 *     `money ÷ scalar = money`.  Anything else involving money falls
 *     through to the left operand's type (best-effort — the validator
 *     is expected to reject the mix upstream).
 *   • Otherwise the existing `int → long → decimal` widening applies
 *     when both operands are in that chain.
 *
 * For non-numeric, non-money operands the function returns the left
 * operand's type (matches the prior behaviour of `widenNumeric`).
 */
/**
 * Lower an expression in a context that knows the target type — used
 * by assignment / derived prop / typed-parameter binding so a bare
 * numeric literal flowing into a money/long/decimal-typed target is
 * elaborated to the matching IR literal kind rather than its
 * source-form default (IntLit → "int", DecLit → "decimal").  Other
 * expressions pass through unchanged.
 *
 * Why this matters:
 *   • For money: backends emit `new Decimal("...")` / `Decimal.new("...")`
 *     for money literals — without elaboration the inline transform
 *     never fires and the literal renders as a raw JS number / float.
 *   • For long: large literals (e.g. `9999999999`) must carry the
 *     `L` suffix when emitted to C# (`long big = 9999999999L;`),
 *     otherwise the literal parses as int and overflows.  Without
 *     elaboration the IR carries `lit("int", ...)` and the .NET
 *     emitter has no signal to add the suffix.
 *   • For decimal: backends mostly tolerate `lit("int", "5")` in a
 *     decimal context via implicit conversions (C# / TS), but the
 *     IR-side type-honesty is the bridge for any future emitter
 *     (Rust's `rust_decimal::Decimal::from(5)` vs raw `5`).
 *
 * The promotion is one-sided in all cases: a typed VALUE (e.g.
 * `taxRate: decimal` used in a money context, or `count: int` used
 * in a long context) still rejects per the strict binary validator
 * (#506).  Only bare IntLit / DecLit AST nodes — which carry no
 * user-chosen type — flow.
 */
export function lowerExprInContext(
  expr: Expression | undefined,
  expected: TypeIR,
  env: Env,
): ExprIR {
  if (expr && expected.kind === "primitive") {
    const promoted = tryPromoteNumericLit(expr, expected.name);
    if (promoted) return promoted;
  }
  return lowerExpr(expr, env);
}

/** Detect a bare numeric literal AST node and rewrite it to the
 *  target primitive's literal IR kind.  Returns null for any
 *  expression that isn't an IntLit or DecLit (typed values, member
 *  access, calls, etc.) — those keep their original lowering and
 *  remain subject to the strict same-value-type rules.
 *
 *  Promotions:
 *    IntLit → "long"    when target is long      (.NET emits L suffix)
 *    IntLit → "decimal" when target is decimal   (.NET emits m suffix)
 *    IntLit → "money"   when target is money
 *    DecLit → "money"   when target is money
 *    DecLit → "decimal" is a no-op (already lit("decimal", ...))
 *
 *  Narrowing (DecLit → int, DecLit → long) is intentionally NOT
 *  admitted — a fractional literal in an integer context is almost
 *  certainly a typo, and the strict gate should surface it. */
/** When a binary operand is typed as long / decimal / money, that
 *  type is the "anchor" the other operand's bare numeric literal
 *  promotes against (the binary handler in `lowerExpr`).  Returns
 *  null for non-anchor types (int, string, bool, etc.) — int doesn't
 *  anchor anything because every IntLit already types as int. */
function literalPromotionAnchor(t: TypeIR): "long" | "decimal" | "money" | null {
  if (t.kind !== "primitive") return null;
  if (t.name === "long" || t.name === "decimal" || t.name === "money") return t.name;
  return null;
}

function tryPromoteNumericLit(expr: Expression, target: PrimitiveName): ExprIR | null {
  if (target === "money") {
    if (isIntLit(expr)) return lit("money", String(expr.value));
    if (isDecLit(expr)) return lit("money", expr.value);
  }
  if (target === "long") {
    if (isIntLit(expr)) return lit("long", String(expr.value));
  }
  if (target === "decimal") {
    if (isIntLit(expr)) return lit("decimal", String(expr.value));
  }
  return null;
}

/** Wrap a value-IR in a `convert` IR with target=string so backends
 *  emit the same to-string form they'd produce for an explicit
 *  `string(x)` source-level call.  Used by the lowering binary
 *  handler for implicit `string + X` concat — the validator has
 *  already accepted the combination via `arithmeticResult`.
 *
 *  `from` is derived from the operand's source type — same primitive
 *  name for primitives, `"enum"`/`"id"` sentinels for the non-
 *  primitive admitted sources so backend `renderConvert` dispatches
 *  consistently. */
function wrapInStringConvert(value: ExprIR, fromType: TypeIR): ExprIR {
  let from: PrimitiveName | undefined;
  if (fromType.kind === "primitive") from = fromType.name;
  // enum and `X id` are admitted as stringifiable but aren't
  // primitives; backends inspect the wrapped value's runtime shape
  // (enum value, id newtype) and pick the right host call.  Leaving
  // `from` undefined here is the signal to the backend `convert`
  // renderer to use the source operand's shape via the value
  // itself (rather than the typed-primitive switch).
  return { kind: "convert", target: "string", from, value };
}

/** Lowering hook for the implicit `string + X` concat rule when X is
 *  one of the admitted sources.  Primitives / enum / id wrap in a
 *  `convert` IR (backend-dispatched stringification).  Aggregates
 *  rewrite to a `member(aggregate, "display")` access — `display` is
 *  already string-typed, so no convert wrap is needed.  Both shapes
 *  produce a string-typed result; downstream binary lowering doesn't
 *  need to distinguish. */
function wrapForStringConcat(value: ExprIR, fromType: TypeIR): ExprIR {
  if (fromType.kind === "entity") {
    return {
      kind: "member",
      receiver: value,
      member: "display",
      receiverType: fromType,
      memberType: { kind: "primitive", name: "string" },
    };
  }
  return wrapInStringConvert(value, fromType);
}

/** Mirror of `type-system.ts`'s `isImplicitlyStringifiable`, on
 *  `TypeIR` instead of `DddType`.  Same set: numeric primitives,
 *  bool, enum, `X id`, plus aggregates that declare a
 *  `derived display: string`.  Used by the lowering binary handler
 *  to decide whether to inject a `convert` node (primitives / enum /
 *  id) or rewrite the operand to `aggregate.display` (aggregates). */
function isImplicitlyStringifiableIR(t: TypeIR, env: Env): boolean {
  if (isImplicitlyStringifiablePrimitiveOrEnum(t)) return true;
  if (t.kind === "entity") return entityHasDisplay(t.name, env);
  return false;
}

/** Env-free subset of `isImplicitlyStringifiableIR` — admits the
 *  primitives / enum / X id that don't need an aggregate lookup.
 *  Used by `binaryResultType` (which has no env) to decide the
 *  result type of `string + X` without re-doing the aggregate
 *  display lookup; aggregate operands fall through to the
 *  type-system-level rule when env-aware code runs. */
function isImplicitlyStringifiablePrimitiveOrEnum(t: TypeIR): boolean {
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

/** True iff `name` resolves to an aggregate (in the current bounded
 *  context) that declares a `derived display: string`.  Entity parts
 *  don't participate; the validator's check on reserved derived names
 *  is aggregate-only. */
function entityHasDisplay(name: string, env: Env): boolean {
  const agg = env.ctx?.members.find((m): m is Aggregate => isAggregate(m) && m.name === name);
  if (!agg) return false;
  return agg.members.some((m) => isDerivedProp(m) && m.name === "display");
}

function binaryResultType(op: string, a: TypeIR, b: TypeIR): TypeIR {
  if (op === "&&" || op === "||") return { kind: "primitive", name: "bool" };
  if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    return { kind: "primitive", name: "bool" };
  }
  // Implicit string concatenation: `string + X` where X is
  // stringifiable returns string.  Mirrors `arithmeticResult` in
  // `type-system.ts` — the lowering wraps the non-string operand in
  // a `convert` IR node so backends emit identical code to the
  // explicit `string(x)` form.
  if (op === "+") {
    const aStr = a.kind === "primitive" && a.name === "string";
    const bStr = b.kind === "primitive" && b.name === "string";
    if (aStr || bStr) {
      const other = aStr ? b : a;
      // Note: `binaryResultType` lives outside of lowering's env-aware
      // path; for aggregate-with-display admission we'd need the env,
      // which the caller has but doesn't thread here.  The lowering
      // binary handler computes the result type itself afterwards via
      // `binaryResultType(op, leftType, rightType)`; if we miss
      // admission here for an `entity` operand, the result type just
      // falls through to the type-system rule (string + aggregate
      // already admitted at AST-level via `arithmeticResult`).
      if ((aStr && bStr) || isImplicitlyStringifiablePrimitiveOrEnum(other)) {
        return { kind: "primitive", name: "string" };
      }
    }
  }
  const aIsMoney = a.kind === "primitive" && a.name === "money";
  const bIsMoney = b.kind === "primitive" && b.name === "money";
  if (aIsMoney || bIsMoney) {
    if (aIsMoney && bIsMoney) {
      return op === "+" || op === "-" ? { kind: "primitive", name: "money" } : a;
    }
    const other = aIsMoney ? b : a;
    if (other.kind !== "primitive") return a;
    const isScalar = other.name === "int" || other.name === "long" || other.name === "decimal";
    if (!isScalar) return a;
    if (op === "*") return { kind: "primitive", name: "money" };
    if (op === "/" && aIsMoney) return { kind: "primitive", name: "money" };
    return a;
  }
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
        // Sum preserves the element type for money arrays so the
        // string-on-wire precision is maintained end-to-end; numeric
        // element types continue to widen to decimal (the existing
        // JS-friendly default).
        if (t.element.kind === "primitive" && t.element.name === "money") {
          return { kind: "primitive", name: "money" };
        }
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

/** Type after applying one postfix suffix to a receiver of type `t`.
 *  Mirrors `applySuffixToRecv` in the lowering layer, but on TypeIR
 *  only.  For `CallSuffix` on a non-NameRef receiver the result is a
 *  string-typed placeholder (matches the legacy CallExpr typing). */
function inferSuffixType(t: TypeIR, suffix: PostfixSuffix, env: Env): TypeIR {
  if (isCallSuffix(suffix)) {
    // Invoking the receiver — without knowing the callee's signature
    // we fall back to string (matches legacy CallExpr typing).
    return { kind: "primitive", name: "string" };
  }
  const ms = suffix as MemberSuffix;
  return memberType(t, ms.member, env);
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
export function provSiteFor(
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

export function pathType(path: PathIR, env: Env): TypeIR {
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
