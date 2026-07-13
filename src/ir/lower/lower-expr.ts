import type { AstNode } from "langium";
import { AstUtils } from "langium";
import type {
  Aggregate,
  AggregateMember,
  BinaryChain,
  BuilderCall,
  Criterion,
  EntityPart,
  EntityPartMember,
  EventDecl,
  Expression,
  FunctionDecl,
  Lambda,
  MemberSuffix,
  PayloadDecl,
  PolicyDecl,
  PostfixChain,
  PostfixSuffix,
  Projection,
  Property,
  ValueObject,
  Workflow,
} from "../../language/generated/ast.js";
import {
  isAggregate,
  isAwaitExpr,
  isBinaryChain,
  isBoolLit,
  isBuilderCall,
  isCallSuffix,
  isContainment,
  isCriterion,
  isDecLit,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isFunctionDecl,
  isIdRef,
  isIntLit,
  isLambda,
  isListLit,
  isMatchExpr,
  isMemberSuffix,
  isMoneyLit,
  isNameRef,
  isNowExpr,
  isNullLit,
  isObjectLit,
  isOperation,
  isParenExpr,
  isPayloadDecl,
  isPolicyDecl,
  isPostfixChain,
  isPrimitiveConversion,
  isProperty,
  isStringLit,
  isTemplateStr,
  isTernaryExpr,
  isThisRef,
  isUnaryExpr,
  isValueObject,
  type TemplateStr,
} from "../../language/generated/ast.js";
import { isCollectionOp } from "../../util/collection-ops.js";
import { bodyTypeOf } from "../../util/expr-body-type.js";
import { isIntrinsicMatcher } from "../../util/intrinsic-matchers.js";
import { intrinsicFor, intrinsicReturnType } from "../../util/intrinsics.js";
import { PRINCIPAL_ORG_PATH, PRINCIPAL_ROOT_ORG } from "../../util/principal.js";
import { durationUnitOf } from "../../util/temporal.js";
import { findVerb, type ResourceVerbDef } from "../resource-verbs.js";
import { variantTag } from "../stdlib/unions.js";
import type {
  ExprIR,
  IdValueType,
  PathIR,
  PrimitiveName,
  ProvSite,
  StmtIR,
  StyleIR,
  TypeIR,
} from "../types/loom-ir.js";
import { lit } from "../types/loom-ir.js";
import { snapshotIdFor } from "../util/prov-id.js";
import { lowerStatement } from "./lower-stmt.js";
import {
  cstText,
  type Env,
  findDomainServiceByName,
  findEntityByName,
  findEventByName,
  findFunctionInEnv,
  findOperationInEnv,
  findPayloadByName,
  findValueObjectByName,
  findWorkflowByName,
  inAggregate,
  lowerAtom,
  lowerType,
  USER_SHAPE_NAME,
  withLocal,
} from "./lower-types.js";
import { originFor } from "./origin.js";
import { matchRepoRead } from "./repo-read.js";

/** Synthetic entity name used to type the `currentUser` magic
 *  identifier.  Member access on the user shape resolves through
 *  `env.user.fields` rather than the bounded-context namespace, so
 *  the name doesn't collide with any user-declared aggregate / part. */

/** Synthetic entity name used to type an ambient resource handle.  A
 *  `.verb(...)` call on a ref of this type lowers to a `resource-op`;
 *  the name carries no members of its own (Phase 4). */
const RESOURCE_HANDLE_SHAPE = "__ResourceHandle";

// ── Ambient root-level enum index ─────────────────────────────────────
// Root-level (`enum X { … }` outside any `context`) enums are an ambient
// shared kernel — every context in the import graph may reference their
// values by bare name (`priority: Normal`).  Enrichment folds them into
// each context's `enums`, but that runs AFTER lowering, and in a
// multi-file project the enum lives in a different document than the
// context being lowered, so `resolveBareName`'s context-member scan can't
// see it.  Without this, `Normal` lowers to `refKind: "unknown"` and
// renders as a bare, undefined identifier (`priority: Normal`) instead of
// the qualified const (`priority: Priority.Normal`).
//
// `lowerProject` collects the project-global value→enum index once (across
// every document) and installs it here before lowering any body.  It's a
// fallback only — context-local enums still win — and lowering is a
// synchronous single pass, so the scoped index is safe.  First declaration
// wins on a value-name collision across root enums (the validator owns the
// ambiguity diagnostic).
let ambientEnumIndex: ReadonlyMap<string, string> = new Map();

export function setAmbientEnumIndex(index: ReadonlyMap<string, string>): void {
  ambientEnumIndex = index;
}

// Project-global index of TOP-LEVEL (ambient) helper `function`s (stdlib
// Phase B), name → decl.  Installed once by `lowerModel` before any body is
// lowered (single synchronous pass, so the module-global is safe — same
// posture as `ambientEnumIndex`).  A call to one of these inlines its
// expression body at the call site (`inlineTopLevelFn`), so it needs no
// owning aggregate.  Only expression-form functions are indexed usefully;
// block-form at top level is rejected by the validator.
let topLevelFnIndex: ReadonlyMap<string, FunctionDecl> = new Map();

export function setTopLevelFnIndex(index: ReadonlyMap<string, FunctionDecl>): void {
  topLevelFnIndex = index;
}

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
  // Probe: a repository READ in a `reading` domain-service body
  // (domain-services.md rev. 4) — `Accounts.byHolder(h)` /
  // `Accounts.find/findAll/run(...)`.  Fires only when `env.serviceRepos` is
  // set (i.e. we are lowering a domain-service operation) and the whole chain
  // matches a recognised repository read.  Lowers to a fully-resolved
  // `repo-read` Call so a backend renders a real repository call without
  // re-recognising the AST.  A repository WRITE does NOT match here (it falls
  // through to the generic method-call and the validator's repo-write gate).
  if (env.serviceRepos) {
    const read = matchRepoRead(chain, env.serviceRepos);
    if (read) {
      const aggName = read.repo.aggregate?.ref?.name ?? "Unknown";
      const args = read.args.map((a) => lowerExpr(a, env));
      // Carry the criterion / retrieval identity through, mirroring the
      // workflow `repo-run` path: a `find`/`findAll` (and an anonymous `run`)
      // read rides a synthesized `findAllBy<Criterion>` retrieval (materialised
      // by the enrich pass from the criterion body), a NAMED `run` read rides
      // the referenced retrieval.  The backend renders THAT retrieval method, so
      // the criterion actually filters the query instead of being dropped for a
      // whole-table read.
      const retrievalName =
        read.retrievalName ?? (read.criterionName ? `findAllBy${read.criterionName}` : undefined);
      const callIR: ExprIR = {
        kind: "call",
        callKind: "repo-read",
        name: read.method,
        args,
        repoRead: {
          repo: read.repo.name,
          aggregate: aggName,
          method: read.method,
          readKind: read.kind,
          ...(retrievalName ? { retrievalName } : {}),
          ...(read.criterionName ? { synthCriterion: { name: read.criterionName } } : {}),
        },
      };
      return callIR;
    }
  }
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
  // Named policy-function CALL at the chain head (`IsManager()` /
  // `CanApprove(amount)`, auth P3.2) — inline the ambient predicate body with
  // the call arguments, then apply any trailing suffixes.  Handled here (not
  // via the `recv.kind === "ref"` call branch below) because a PARAMETERLESS
  // policy function resolves eagerly to its inlined body in `resolveNameRef`,
  // so by the time a `()` suffix is applied the head is no longer a callable
  // ref — the criterion path has the same latent shape but is never called
  // with parens, whereas a policy function always is.
  if (isNameRef(chain.head) && first && isCallSuffix(first)) {
    const pf = findPolicyFnInEnv(env, chain.head.name);
    if (pf) {
      const args = first.args.map((a) => lowerExpr(a.value, env));
      let recv: ExprIR = inlinePolicyFn(pf, args, env);
      let recvType: TypeIR = { kind: "primitive", name: "bool" };
      for (let i = 1; i < chain.suffixes.length; i++) {
        const out = applySuffixToRecv(recv, recvType, chain.suffixes[i]!, env);
        recv = out.recv;
        recvType = out.recvType;
      }
      return recv;
    }
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
      // Parameterised policy-function call (`CanApprove(cap)`) — inline the
      // ambient predicate body with the call arguments substituted (auth P3.2).
      const policyFn = findPolicyFnInEnv(env, recv.name);
      if (policyFn) {
        return {
          recv: inlinePolicyFn(policyFn, args, env),
          recvType: { kind: "primitive", name: "bool" },
        };
      }
      const callKind = resolveCallKind(recv.name, env);
      // Top-level (ambient) helper `function` call (stdlib Phase B) — inline
      // its expression body with the arguments substituted.  Gated on
      // `callKind === "free"` so a LOCAL member (aggregate/VO/workflow
      // function, operation, VO ctor) of the same name shadows the top-level
      // one; and, running before the duration-builtin check below, a user
      // `function days(...)` shadows the A5 `days()` builtin.
      if (callKind === "free") {
        const topFn = findTopLevelFn(recv.name);
        if (topFn) {
          return {
            recv: inlineTopLevelFn(topFn, args, env),
            recvType: lowerType(topFn.returnType),
          };
        }
      }
      // A5 duration constructor — `days(n)` / `hours(n)` / `minutes(n)`
      // becomes a dedicated `duration` IR node, but ONLY when
      // the name resolved to nothing user-declared (`resolveCallKind`
      // checks user functions / operations / VO ctors first, and the
      // criterion probe above ran before this — so a user `function
      // days(...)` shadows the builtin and lowers as a plain call).
      // Wrong-arity calls fall through to the plain free call; the
      // validator (`loom.duration-arity`) reports them.
      if (callKind === "free" && args.length === 1) {
        const unit = durationUnitOf(recv.name);
        if (unit) {
          return {
            recv: { kind: "duration", unit, amount: args[0]! },
            recvType: { kind: "primitive", name: "duration" },
          };
        }
      }
      const callIR: ExprIR = {
        kind: "call",
        callKind,
        name: recv.name,
        args,
        ...(named ? { argNames } : {}),
        ...(styleHoist.style ? { style: styleHoist.style } : {}),
        // A workflow `function` is emitted as a per-workflow-scoped helper (not
        // a `this`-method — a workflow body is not a class), so the call carries
        // the enclosing workflow name; each backend renders `<wf><fn>(args)`.
        ...(callKind === "workflow-fn" && env.workflow ? { wfScope: env.workflow.name } : {}),
        // An operation self-call lowers to `private-operation` regardless of the
        // target's `private` modifier; carry the resolved privacy so backends
        // that name public vs private operations differently render the call
        // against the right def-site name (Python `self.reserve` vs `self._reserve`).
        ...(callKind === "private-operation"
          ? { targetPrivate: findOperationInEnv(env, recv.name)?.private ?? false }
          : {}),
      };
      // Result type best-effort — a function returns its declared type, an
      // operation returns its declared return type (an `or`-union for an
      // exception-less op, so a `let x = reserve()` types as the union; the `?`
      // propagation operator builds on this), a value-object ctor returns the
      // VO, everything else falls back to a string placeholder (matches the
      // legacy inferExprType).
      let resultType: TypeIR = { kind: "primitive", name: "string" };
      const fn = findFunctionInEnv(env, recv.name);
      if (fn) resultType = lowerType(fn.returnType);
      else {
        const op = findOperationInEnv(env, recv.name);
        if (op?.returnType) resultType = lowerType(op.returnType, env);
        else {
          const vo = findValueObjectByName(env, recv.name);
          if (vo) resultType = { kind: "valueobject", name: vo.name };
        }
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
  // `<Store>.<member>` — a dotted store reference from a page/component/store
  // body (named-actions-and-stores.md §3, Stage 5).  When the receiver is a
  // bare ref naming an in-scope store, `.field` resolves to a `store-field`
  // ref and `.action(…)` to a `store-action` call, both carrying the store
  // name so backends never re-resolve.  Checked before the generic member /
  // method-call paths so a store name shadows nothing it shouldn't.
  if (recv.kind === "ref" && env.stores?.has(recv.name)) {
    const store = env.stores.get(recv.name) as {
      fields: Map<string, TypeIR>;
      actions: Map<string, { paramType?: TypeIR }>;
    };
    const storeName = recv.name;
    if (ms.call) {
      const args = ms.args.map((a) => lowerExpr(a.value, env));
      const argNames = ms.args.map((a) => a.name || undefined);
      const callIR: ExprIR = {
        kind: "call",
        callKind: "store-action",
        name: ms.member,
        args,
        ...(argNames.some((n) => n !== undefined) ? { argNames } : {}),
        storeAction: { store: storeName, action: ms.member },
      };
      // A store action has no return value (it reduces to state); type the
      // call as the unit-ish string placeholder the other void calls use.
      return { recv: callIR, recvType: { kind: "primitive", name: "string" } };
    }
    const fieldType = store.fields.get(ms.member) ?? { kind: "primitive", name: "string" };
    return {
      recv: { kind: "ref", name: ms.member, refKind: "store-field", storeName, type: fieldType },
      recvType: fieldType,
    };
  }
  if (ms.call) {
    // For a collection op (`any`/`filter`/`map`/`sum`/…) on an array
    // receiver, lower a lambda arg with the receiver's ELEMENT type bound
    // to its param — so `lines.any(l => l.price + 10.00 > total)` types `l`
    // at the line element and its `.price` money member renders as Decimal
    // arithmetic, not a `String(...)` concat on the placeholder type.
    const collElem = isCollectionOp(ms.member) ? collectionElementType(recvType) : undefined;
    const args = ms.args.map((a) =>
      collElem && isLambda(a.value) ? lowerLambda(a.value, env, collElem) : lowerExpr(a.value, env),
    );
    const argNames = ms.args.map((a) => a.name || undefined);
    // `Pricing.quote(args)` — a member call whose receiver resolves to a
    // `domainService` declaration lowers to a Call with `callKind:
    // "domain-service"` and the structured `serviceRef`, so backends emit
    // a real call into the generated service module without re-resolving
    // the receiver (domain-services.md).  Resolution is by bare name —
    // env-local context members first, then the project-global ambient
    // index for a sibling-context service.
    if (recv.kind === "ref") {
      const svc = findDomainServiceByName(env, recv.name);
      if (svc) {
        const opDecl = svc.operations.find((o) => o.name === ms.member);
        const callIR: ExprIR = {
          kind: "call",
          callKind: "domain-service",
          name: ms.member,
          args,
          ...(argNames.some((n) => n !== undefined) ? { argNames } : {}),
          serviceRef: { service: svc.name, op: ms.member },
        };
        // Result type is the operation's declared return type (an `or`-union
        // for an exception-less op, so `let x = Pricing.applyCoupon(...)?`
        // propagates the error variant); falls back to string when the op
        // declares no `: T`.
        const resultType: TypeIR = opDecl?.returnType
          ? lowerType(opDecl.returnType, env)
          : { kind: "primitive", name: "string" };
        return { recv: callIR, recvType: resultType };
      }
    }
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
          ...(verbDef?.interfaceOverride ? { interface: verbDef.interfaceOverride } : {}),
        },
      };
      const resultType = verbResultType(verbDef);
      return { recv: callIR, recvType: resultType };
    }
    // A collection op needs a collection receiver: a string-receiver
    // `contains` (or any future name collision) is the scalar INTRINSIC,
    // not the collection op — key the flag off the receiver type so the
    // renderers dispatch to the intrinsic snippet tables instead.
    const collectionOp =
      isCollectionOp(ms.member) &&
      !(recvType.kind === "primitive" && intrinsicFor(recvType.name, ms.member) !== undefined);
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
    let nextType = memberType(recvType, ms.member, env);
    // `map(λ)` returns an array of the lambda's body type; `memberType`
    // can't see the lambda, so type it here at the call site from the
    // lowered lambda body (best-effort — falls back to the element type).
    if (collectionOp && ms.member === "map") {
      const lam = args[0];
      const bodyT = lam?.kind === "lambda" && lam.body ? bodyTypeOf(lam.body) : undefined;
      const elem = collectionElementType(recvType) ?? { kind: "primitive", name: "string" };
      nextType = { kind: "array", element: bodyT ?? elem };
    }
    // `min(λ)`/`max(λ)` return the PROJECTED value, optional (empty → null).
    // `memberType` can't see the lambda, so refine the element type here from
    // the lowered lambda body (falls back to the collection element type).
    if (collectionOp && (ms.member === "min" || ms.member === "max")) {
      const lam = args[0];
      const bodyT = lam?.kind === "lambda" && lam.body ? bodyTypeOf(lam.body) : undefined;
      const elem = collectionElementType(recvType) ?? { kind: "primitive", name: "string" };
      nextType = { kind: "optional", inner: bodyT ?? elem };
    }
    return { recv: mcIR, recvType: nextType };
  }
  // Qualified enum value `EnumName.Value` — when the receiver is an
  // unresolved bare name matching a declared enum and the member names one of
  // its values, resolve the whole access to an `enum-value` ref (carrying
  // `enumName` + the enum type), exactly as a bare enum value resolves.
  // Without this, a `when` / invariant predicate's `Status.Draft` stays a
  // member access on an unknown `Status` ref and backends emit an undefined
  // identifier (e.g. Hono TS2304 'Status').
  if (recv.kind === "ref" && recv.refKind === "unknown") {
    const enumName = recv.name;
    const localEnum =
      env.ctx?.members.some(
        (m) => isEnumDecl(m) && m.name === enumName && m.values.some((v) => v.name === ms.member),
      ) ?? false;
    const rootEnum = ambientEnumIndex.get(ms.member) === enumName;
    if (localEnum || rootEnum) {
      return {
        recv: {
          kind: "ref",
          name: ms.member,
          refKind: "enum-value",
          enumName,
          type: { kind: "enum", name: enumName },
        },
        recvType: { kind: "enum", name: enumName },
      };
    }
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

// ---------------------------------------------------------------------------
// `?` propagation helpers (exception-less.md A2).
// ---------------------------------------------------------------------------

/** True when `tag` names an `error` payload visible from the lowering context
 *  — walking the context → subdomain → system → model container chain so a
 *  context-local *and* an ambient root-level `error` both classify.  Drives the
 *  per-variant-arm `isError` stamp the Elixir backend's `{:ok,…}`/`{:error,…}`
 *  tuple `case` depends on (variant-match.md). */
export function isErrorVariantTag(tag: string, env: Env): boolean {
  let node: { members?: readonly unknown[]; $container?: unknown } | undefined = env.ctx;
  while (node) {
    if (node.members?.some((m) => isPayloadDecl(m) && m.name === tag && m.kind === "error")) {
      return true;
    }
    node = node.$container as { members?: readonly unknown[]; $container?: unknown } | undefined;
  }
  return false;
}

/** Lower a lambda body, binding its parameter at `paramType` in a fresh
 *  local scope.  `paramType` is the string placeholder for a bare lambda
 *  and the receiver's ELEMENT type for a collection-op lambda arg
 *  (`lines.any(l => l.price > total)` → `l` typed at the line element), so
 *  member accesses and binaries inside the body get the right
 *  receiver/member/left types — backends never re-resolve. */
function lowerLambda(expr: Lambda, env: Env, paramType: TypeIR): ExprIR {
  const inner = withLocal(env, expr.param, "lambda", paramType);
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

/** The element type of a collection receiver — unwrapping an outer
 *  `optional` (`xs?.any(...)`) then reading the `array` element.  Returns
 *  `undefined` for a non-collection receiver so the caller can fall back to
 *  the plain lambda path. */
function collectionElementType(t: TypeIR): TypeIR | undefined {
  const unwrapped = t.kind === "optional" ? t.inner : t;
  return unwrapped.kind === "array" ? unwrapped.element : undefined;
}

/** Lower an expression, then stamp its `.ddd` (or macro-call) origin onto
 *  the result — the expression-side twin of `lowerStatement`'s chokepoint
 *  (src/ir/lower/lower-stmt.ts), same shape.  Every recursive `lowerExpr`
 *  call below (in this file and its siblings) routes back through this
 *  wrapper, so each sub-expression node gets its own stamp; only the
 *  synthetic intermediates built directly as object literals — a binary
 *  chain's fold accumulators, a postfix chain's per-suffix nodes, lambda/
 *  builder/criterion internals — never pass back through here and so stay
 *  `origin: undefined` (honest: consumers already skip undefined).  For a
 *  chain expression the OUTERMOST node picks up the whole chain's span,
 *  which is correct — that's what the source expression covers.
 *
 *  `originFor` walks `$container` / `getDocument` from the AST node (a
 *  shallow 5-10 hop root-walk per node) — accepted per-node cost, no
 *  cache; see docs/plans/source-map-debug-kickoff.md. */
export function lowerExpr(expr: Expression | undefined, env: Env): ExprIR {
  const lowered = lowerExprInner(expr, env);
  return { ...lowered, origin: lowered.origin ?? originFor(expr) };
}

function lowerExprInner(expr: Expression | undefined, env: Env): ExprIR {
  if (!expr) return lit("null", "null");
  if (isStringLit(expr)) return lit("string", expr.value);
  if (isTemplateStr(expr)) return lowerTemplateString(expr, env);
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
  if (isAwaitExpr(expr)) {
    // `await <call>` (async-actions-and-effects.md Stage 2) — lower the inner
    // remote call and mark it `awaited`, so the frontend walker wraps its
    // variant-match in the async envelope.  A spurious `await` on a non-call is
    // returned unmarked; the validator (`loom.spurious-effect-marker`) flags it.
    const inner = lowerExpr(expr.inner, env);
    if (inner.kind === "call" || inner.kind === "method-call") {
      return { ...inner, awaited: true };
    }
    return inner;
  }
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
      // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then` across the IR
      then: lowerExpr(expr.thenExpr, env),
      otherwise: lowerExpr(expr.elseExpr, env),
    };
  }
  if (isLambda(expr)) {
    // A bare lambda outside a collection-op call site has no known param
    // type — the string placeholder matches the legacy behaviour.  The
    // collection-op path lowers its lambda arg through `lowerLambda`
    // directly with the receiver's element type (see `applySuffixToRecv`).
    return lowerLambda(expr, env, { kind: "primitive", name: "string" });
  }
  if (isMatchExpr(expr)) {
    // Variant form (`match SUBJECT { VariantType binding => value }`,
    // variant-match.md): subject present.  Lower the scrutinee once, read
    // its resolved union TypeIR, and for each arm bind the (optional)
    // binding name as a REAL narrowed local typed at the matched variant
    // — the if-let / lambda-param narrowing analog.  A reference to the
    // binding inside the arm value then resolves through the ordinary
    // local path (`refKind: "match-binding"`, carrying the variant type),
    // so member reads on it get full receiver/member types.
    if (expr.subject) {
      const subject = lowerExpr(expr.subject, env);
      // A plain ref subject carries its own resolved type; an `await <call>`
      // subject (Stage 2) is a call whose type is the op's `or`-union return —
      // resolve it via `inferExprType` so the variant-arm set is available for
      // exhaustiveness checks and backends never re-resolve.
      const subjectType = subject.kind === "ref" ? subject.type : inferExprType(expr.subject, env);
      // A subject bound to a repository union find carries the absence
      // runtime shape (bare aggregate-or-absent), not the tagged wire —
      // stamp it so backends render a presence check instead of a
      // discriminator probe (payloads.md §Union finds).  Only lowering
      // knows the find origin; renderers must never re-derive this.
      const absenceSubject =
        subject.kind === "ref" && env.locals.get(subject.name)?.absenceUnion === true;
      return {
        kind: "match",
        subject,
        subjectType,
        ...(absenceSubject ? { subjectShape: "absence" as const } : {}),
        arms: [],
        variantArms: expr.varArms.map((arm) => {
          const varType = lowerAtom(arm.varType, env);
          // Absence subject: the binding is an alias of the subject itself,
          // narrowed to the matched variant — lower references to it as a
          // subject ref typed at `varType` (Env.refAliases), so backends see
          // an ordinary local read (no tagged-carrier binding exists at
          // runtime).  Tagged subject: the ordinary match-binding local.
          const armEnv = !arm.binding
            ? env
            : absenceSubject && subject.kind === "ref"
              ? {
                  ...env,
                  refAliases: new Map([
                    ...(env.refAliases ?? []),
                    [arm.binding, { ...subject, type: varType }],
                  ]),
                }
              : withLocal(env, arm.binding, "match-binding", varType);
          return {
            varType,
            binding: arm.binding,
            value: lowerExpr(arm.value, armEnv),
            // Error-vs-success classification for the asymmetric Elixir tuple
            // representation (variant-match.md).  An error payload in the
            // enclosing context tags as `{:error, …}`; everything else is the
            // `{:ok, …}` success carrier.  Other backends ignore this.
            isError: isErrorVariantTag(variantTag(varType), env),
          };
        }),
        otherwise: expr.elseExpr ? lowerExpr(expr.elseExpr, env) : undefined,
      };
    }
    // Boolean predicate-arms form — lowering is mechanical: each arm
    // becomes a `{ cond, value }` pair, the optional `else => expr`
    // becomes the `otherwise` slot.  Type unification across arms /
    // soundness checks are left to the validator.
    return {
      kind: "match",
      arms: expr.arms.map((arm) => ({
        cond: lowerExpr(arm.cond, env),
        value: lowerExpr(arm.value, env),
      })),
      variantArms: [],
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
    // Carry the value object's declared field order so backends that need
    // named construction (Phoenix `%Mod.VO{field: …}` structs) always have
    // names — positional backends (TS `new VO(…)`, .NET) ignore them.
    const fieldNames = vo.members.filter(isProperty).map((p) => p.name);
    return lowerBuilderCallAsCall(expr, env, name, "value-object-ctor", fieldNames);
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
  // A payload construction (`NotFound { resource: … }`, exception-less.md) is a
  // structural record, not a class — lower it to an object literal so a
  // `return <Error> { … }` renders as a plain object the route can tag.
  const payload = findPayloadByName(env, name);
  if (payload) {
    const fields = expr.entries
      .filter((e) => e.name !== undefined)
      .map((e) => ({ name: e.name as string, value: lowerExpr(e.value, env) }));
    return { kind: "object", fields };
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
  fieldNames?: string[],
): ExprIR {
  // Hoist `style:` named arg into its own IR field — see lowerStyleArg.
  // Filtering happens by index so `args` and `argNames` stay parallel.
  const styleHoist = hoistStyleArg(expr.entries, env);
  const entries = styleHoist.remainingEntries;
  const args = entries.map((e) => lowerExpr(e.value, env));
  // Explicit entry name wins; otherwise fall back to the declared field
  // name at this position (value-object ctors — see lowerBuilderCall).
  const argNames = entries.map((e, i) => e.name || fieldNames?.[i]);
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

/** Locate a FUNCTION-form `policy` declaration by name in the enclosing
 *  context (authorization Phase 3.2).  A block-form `policy {}` (read ladder)
 *  has no `returnType`; only the function form is a callable predicate. */
function findPolicyFnInEnv(env: Env, name: string): PolicyDecl | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isPolicyDecl(m) && m.returnType !== undefined && m.name === name) return m;
  }
  return undefined;
}

/** Inline a named policy-function reference into the host expression
 *  (authorization Phase 3.2).  Unlike a criterion, a policy function is
 *  AMBIENT — it has no candidate aggregate, so the body sees only
 *  `currentUser`, its own parameters (substituted by the caller's already-
 *  lowered arguments), and context-level ambient names (module `permissions`,
 *  enum values, sibling policy functions / criteria).  The enclosing
 *  aggregate/part scope is cleared so a bare field name cannot leak in — pass
 *  such values as arguments.  Because the result is an ordinary boolean
 *  `ExprIR` spliced into a `requires` gate, every backend enforces it through
 *  the existing `requires` → 403 path with no new render code.  A reference
 *  cycle is broken by leaving the inner reference unresolved
 *  (`loom.policy-fn-cycle` reports it).  The generic `criterionArgs` /
 *  `criterionStack` inline-substitution + cycle machinery is reused. */
function inlinePolicyFn(fn: PolicyDecl, args: ExprIR[], env: Env): ExprIR {
  const stack = env.criterionStack ?? [];
  if (stack.includes(fn.name as string)) {
    return { kind: "ref", name: fn.name as string, refKind: "unknown" };
  }
  const argMap = new Map<string, ExprIR>();
  fn.params.forEach((p, i) => {
    const a = args[i];
    if (a) argMap.set(p.name, a);
  });
  const bodyEnv: Env = {
    ...env,
    locals: new Map(),
    aggregate: undefined,
    part: undefined,
    valueObject: undefined,
    workflow: undefined,
    projection: undefined,
    criterionArgs: argMap,
    criterionStack: [...stack, fn.name as string],
  };
  // `body` is always present on a function-form PolicyDecl (grammar), but the
  // AST types it optional (shared with the block form) — guard defensively.
  return fn.body
    ? lowerExpr(fn.body, bodyEnv)
    : { kind: "ref", name: fn.name as string, refKind: "unknown" };
}

/** When `where`/`filter` is *exactly* one named `criterion` reference — a
 *  bare parameterless criterion (`ActiveCustomer`) or a parameterised call
 *  (`InRegion("EU")`) — return the criterion name + its lowered argument
 *  expressions; otherwise `undefined` (composed / anonymous clause).
 *
 *  Reified-criteria Slice 2b: lets retrieval/find lowering record the
 *  reference so a backend can consume the reified `Criterion` / Specification,
 *  even though the use-site otherwise keeps no provenance (the clause is still
 *  inlined into the IR for every non-reifying backend). */
export function criterionRefOf(
  where: Expression | undefined,
  env: Env,
): { name: string; args: ExprIR[] } | undefined {
  if (!where) return undefined;
  if (isNameRef(where)) {
    const crit = findCriterionInEnv(env, where.name);
    return crit && crit.params.length === 0 ? { name: crit.name, args: [] } : undefined;
  }
  if (isPostfixChain(where) && isNameRef(where.head)) {
    const crit = findCriterionInEnv(env, where.head.name);
    if (!crit) return undefined;
    if (where.suffixes.length === 0 && crit.params.length === 0) {
      return { name: crit.name, args: [] };
    }
    const first = where.suffixes[0];
    if (where.suffixes.length === 1 && first && isCallSuffix(first)) {
      return { name: crit.name, args: first.args.map((a) => lowerExpr(a.value, env)) };
    }
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

/** The top-level (ambient) helper `function` named `name`, or undefined. */
function findTopLevelFn(name: string): FunctionDecl | undefined {
  return topLevelFnIndex.get(name);
}

/** Inline a top-level (ambient) helper `function` at the call site (stdlib
 *  Phase B).  Like `inlinePolicyFn`, the body is AMBIENT — it sees only its
 *  own parameters (substituted by the caller's already-lowered arguments),
 *  context-level ambient names (root enums, sibling top-level functions), and
 *  `currentUser` if present; the enclosing aggregate/part/VO/workflow scope is
 *  cleared so a bare field name can't leak in (pass such values as arguments).
 *  The result is ordinary `ExprIR` spliced at the call site, so every backend
 *  renders it through existing paths and a `where`-clause use stays queryable.
 *  A reference cycle is broken by leaving the inner reference unresolved; the
 *  `loom.function-recursive` validator rejects it at AST-validate time.  Only
 *  the expression form (`= expr`) is inlinable; a block-form top-level function
 *  is rejected by the validator, so `body` is present here in practice. */
function inlineTopLevelFn(fn: FunctionDecl, args: ExprIR[], env: Env): ExprIR {
  const stack = env.criterionStack ?? [];
  if (stack.includes(fn.name)) {
    return { kind: "ref", name: fn.name, refKind: "unknown" };
  }
  const argMap = new Map<string, ExprIR>();
  fn.params.forEach((p, i) => {
    const a = args[i];
    if (a) argMap.set(p.name, a);
  });
  const bodyEnv: Env = {
    ...env,
    locals: new Map(),
    aggregate: undefined,
    part: undefined,
    valueObject: undefined,
    workflow: undefined,
    projection: undefined,
    criterionArgs: argMap,
    criterionStack: [...stack, fn.name],
  };
  const inlined: ExprIR = fn.body
    ? lowerExpr(fn.body, bodyEnv)
    : { kind: "ref", name: fn.name, refKind: "unknown" };
  // Wrap the spliced body in a paren so precedence is preserved at ANY call
  // site — a call boundary groups the body, but the bare inlined ExprIR does
  // not, so `!isBlank(x)` must inline as `!(<body>)`, not `!<body>`.
  return { kind: "paren", inner: inlined };
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
  // Absence-match binding alias (Env.refAliases) — the binding is the
  // narrowed subject itself, so the ref lowers to the aliased subject ref.
  // Checked before locals so the binding shadows a same-named outer local
  // (ordinary binding scoping), after `currentUser`/resources so those stay
  // unshadowable.
  const alias = env.refAliases?.get(name);
  if (alias) return alias;
  const local = env.locals.get(name);
  if (local) {
    const refKind = local.kind;
    return { kind: "ref", name, refKind, type: local.type };
  }
  // Property of enclosing entity / value object / workflow.  A workflow is a
  // state-bearing entity (workflow-and-applier.md A2): its `Property` members
  // resolve as `this`-props exactly like aggregate fields.
  const owner = env.part ?? env.aggregate ?? env.valueObject ?? env.workflow ?? env.projection;
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
        // A workflow `function` is a per-workflow-scoped module helper, not a
        // `this`-method — carry the workflow name so a bare (nullary) reference
        // renders `<wf><fn>` rather than `this.<fn>`.
        if (owner === env.workflow) {
          return { kind: "ref", name, refKind: "workflow-fn", wfScope: env.workflow?.name };
        }
        return { kind: "ref", name, refKind: "helper-fn" };
      }
    }
  }
  // Named page/component action reference — a bare `onSubmit: next` /
  // `rowAction: add` handler arg.  Resolves to a fully-typed `action-ref`
  // carrying the action's single declared payload param type (undefined ⇒
  // nullary), so backends + the validator never re-resolve.  `env.actions`
  // is populated only while lowering a page/component body; elsewhere this
  // is skipped and the name falls through to the ordinary path.
  if (env.actions?.has(name)) {
    const { paramType } = env.actions.get(name) as { paramType?: TypeIR };
    return { kind: "action-ref", actionName: name, ...(paramType ? { paramType } : {}) };
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
    // Parameterless policy-function reference (`IsManager`) — inline the
    // ambient predicate body (auth P3.2).  A parameterised policy function
    // referenced bare falls through; the validator reports the arity mismatch
    // (`loom.policy-fn-arity`).
    const policyFn = findPolicyFnInEnv(env, name);
    if (policyFn && policyFn.params.length === 0) {
      return inlinePolicyFn(policyFn, [], env);
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
  // Ambient root-level enum value (`Priority.Normal` from a kernel file).
  // Checked after context-local enums so a same-named local value wins.
  // Gated on `env.ctx` like the context-local enum scan above: an e2e
  // test body (no ctx) renders bare names verbatim, so it must not start
  // resolving names that happen to match a kernel enum value.
  const ambientEnum = env.ctx ? ambientEnumIndex.get(name) : undefined;
  if (ambientEnum) {
    return {
      kind: "ref",
      name,
      refKind: "enum-value",
      enumName: ambientEnum,
      type: { kind: "enum", name: ambientEnum },
    };
  }
  return { kind: "ref", name, refKind: "unknown" };
}

function resolveCallKind(
  name: string,
  env: Env,
): "function" | "workflow-fn" | "value-object-ctor" | "private-operation" | "free" {
  // A workflow's own `function` helper — emitted as a per-workflow-scoped
  // module helper (a workflow body is not a class), so it gets its own callKind
  // distinct from an aggregate `function` (which renders `this.<fn>`).
  if (env.workflow) {
    for (const m of env.workflow.members) {
      if (isFunctionDecl(m) && m.name === name) return "workflow-fn";
    }
  }
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
  if (isTemplateStr(expr)) return { kind: "primitive", name: "string" };
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
    if (env.workflow) return { kind: "entity", name: env.workflow.name };
    if (env.projection) return { kind: "entity", name: env.projection.name };
    return { kind: "primitive", name: "string" };
  }
  if (isIdRef(expr)) {
    if (env.part) return { kind: "id", targetName: env.part.name, valueType: "guid" };
    if (env.aggregate) {
      return {
        kind: "id",
        targetName: env.aggregate.name,
        valueType: "guid" as IdValueType,
      };
    }
    // Workflows have no `ids` clause today — their synthetic id defaults to guid.
    if (env.workflow) return { kind: "id", targetName: env.workflow.name, valueType: "guid" };
    if (env.projection) return { kind: "id", targetName: env.projection.name, valueType: "guid" };
    return { kind: "primitive", name: "string" };
  }
  if (isParenExpr(expr)) return inferExprType(expr.inner, env);
  if (isAwaitExpr(expr)) return inferExprType(expr.inner, env);
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
    if (expr.varArms.length > 0) return inferExprType(expr.varArms[0]!.value, env);
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
    // Probe: `<Store>.<field>` / `<Store>.<action>(…)` — head is a `NameRef`
    // naming an in-scope store (Stage 5).  A field access types as the field's
    // declared type; a store-action call returns no value (string placeholder).
    if (first && isMemberSuffix(first) && isNameRef(expr.head) && env.stores?.has(expr.head.name)) {
      const store = env.stores.get(expr.head.name) as {
        fields: Map<string, TypeIR>;
        actions: Map<string, { paramType?: TypeIR }>;
      };
      curType = first.call
        ? { kind: "primitive", name: "string" }
        : (store.fields.get(first.member) ?? { kind: "primitive", name: "string" });
      for (let i = 1; i < expr.suffixes.length; i++) {
        curType = inferSuffixType(curType, expr.suffixes[i]!, env);
      }
      return curType;
    }
    // Probe: `Pricing.quote(...)` domain-service member call — head is a
    // `NameRef` resolving to a `domainService`, first suffix is a call
    // MemberSuffix naming an operation.  The result type is the operation's
    // declared return type (an `or`-union for an exception-less op, so a
    // `let x = Pricing.applyCoupon(...)?` propagates the error variant).
    // Mirrors the lowering MemberSuffix arm that stamps the call's
    // `recvType` — without this `let`-binds would mis-type as `string`.
    if (first && isMemberSuffix(first) && first.call && isNameRef(expr.head)) {
      const svc = findDomainServiceByName(env, expr.head.name);
      if (svc) {
        const opDecl = svc.operations.find((o) => o.name === first.member);
        curType = opDecl?.returnType
          ? lowerType(opDecl.returnType, env)
          : { kind: "primitive", name: "string" };
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
      // Criterion / policy-function call (`InRegion("EU")` / `CanApprove(cap)`)
      // types as a boolean predicate.
      if (findCriterionInEnv(env, expr.head.name) || findPolicyFnInEnv(env, expr.head.name)) {
        curType = { kind: "primitive", name: "bool" };
        for (let i = 1; i < expr.suffixes.length; i++) {
          curType = inferSuffixType(curType, expr.suffixes[i]!, env);
        }
        return curType;
      }
      const fn = findFunctionInEnv(env, expr.head.name);
      if (fn) curType = lowerType(fn.returnType);
      else {
        // An operation call types as the operation's declared return type — an
        // `or`-union for an exception-less op (so `let x = reserve()` types as
        // the union, the operand `?` propagation consumes).  A void operation
        // has no returnType; fall through to the string placeholder.
        const op = findOperationInEnv(env, expr.head.name);
        if (op?.returnType) curType = lowerType(op.returnType, env);
        else {
          const vo = findValueObjectByName(env, expr.head.name);
          if (vo) curType = { kind: "valueobject", name: vo.name };
          // A5 duration constructor — checked after every user-decl
          // lookup failed, mirroring the lowering's shadowing rule.
          else if (durationUnitOf(expr.head.name))
            curType = { kind: "primitive", name: "duration" };
          else curType = { kind: "primitive", name: "string" };
        }
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
    // Absence-match binding alias — type of the narrowed subject ref.
    const alias = env.refAliases?.get(expr.name);
    if (alias) {
      return "type" in alias && alias.type ? alias.type : { kind: "primitive", name: "string" };
    }
    // Parameterless criterion / policy-function reference types as a boolean
    // predicate.
    const crit = findCriterionInEnv(env, expr.name);
    if (crit && crit.params.length === 0) return { kind: "primitive", name: "bool" };
    const policyFn = findPolicyFnInEnv(env, expr.name);
    if (policyFn && policyFn.params.length === 0) return { kind: "primitive", name: "bool" };
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

/** Lower an `emit E { f: <expr>, … }` field list, promoting a bare numeric
 *  literal against the event field's declared type — the same contextual
 *  promotion the aggregate-create service and `:=` paths apply.  Shared by
 *  the aggregate (`lower-stmt.ts`) and workflow (`lower-workflow.ts`) emit
 *  lowerers so both promote identically (C1). */
export function lowerEmitFields(
  ev: EventDecl | undefined,
  fields: readonly { name: string; value: Expression }[],
  env: Env,
): { name: string; value: ExprIR }[] {
  const fieldTypeOf = new Map<string, TypeIR>();
  if (ev) {
    for (const f of ev.fields) fieldTypeOf.set(f.name, lowerType(f.type, env));
  }
  return fields.map((f) => {
    const target = fieldTypeOf.get(f.name);
    return {
      name: f.name,
      value: target ? lowerExprInContext(f.value, target, env) : lowerExpr(f.value, env),
    };
  });
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

/** A6 string interpolation — lower a backtick template to plain string
 *  concatenation, so no backend sees a new node.  `strings` are the N+1
 *  literal segments (already delimiter-stripped + unescaped by the value
 *  converter), `holes` the N interleaved expressions.  Each hole rides the
 *  same `string + X` path as an explicit `"…" + x`: string-typed holes pass
 *  through unwrapped, other stringifiable holes get the `convert` /
 *  `.display` wrap (`wrapForStringConcat`).  A non-stringifiable hole is
 *  reported by `loom.interp-hole-type` (the AST validator); we still lower it
 *  totally so codegen never sees a half-node.  Empty segments are dropped;
 *  an all-empty template lowers to `""`. */
function lowerTemplateString(expr: TemplateStr, env: Env): ExprIR {
  const stringT: TypeIR = { kind: "primitive", name: "string" };
  const pieces: ExprIR[] = [];
  for (let i = 0; i < expr.strings.length; i++) {
    const seg = expr.strings[i]!;
    if (seg.length > 0) pieces.push(lit("string", seg));
    const holeExpr = expr.holes[i];
    if (holeExpr) {
      const holeIR = lowerExpr(holeExpr, env);
      const holeType = inferExprType(holeExpr, env);
      const isStr = holeType.kind === "primitive" && holeType.name === "string";
      pieces.push(
        isStr || !isImplicitlyStringifiableIR(holeType, env)
          ? holeIR
          : wrapForStringConcat(holeIR, holeType),
      );
    }
  }
  if (pieces.length === 0) return lit("string", "");
  let acc = pieces[0]!;
  for (let i = 1; i < pieces.length; i++) {
    acc = {
      kind: "binary",
      op: "+",
      left: acc,
      right: pieces[i]!,
      leftType: stringT,
      resultType: stringT,
    };
  }
  return acc;
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
  // A5 temporal — the env-free mirror of the type-system's
  // `temporalArithmetic` (src/language/type-system.ts), so the lowered
  // binary node's `resultType` stamp agrees with what `typeOf` reported
  // and the backends' operand-type dispatch (datetime ± duration vs
  // dt − dt) never re-infers.  Ill-typed combinations fall through to
  // the left type (validator already reported them).
  {
    const an = a.kind === "primitive" ? a.name : undefined;
    const bn = b.kind === "primitive" ? b.name : undefined;
    if (an === "datetime" && bn === "duration" && (op === "+" || op === "-")) {
      return { kind: "primitive", name: "datetime" };
    }
    if (an === "duration" && bn === "datetime" && op === "+") {
      return { kind: "primitive", name: "datetime" };
    }
    if (an === "datetime" && bn === "datetime" && op === "-") {
      return { kind: "primitive", name: "duration" };
    }
    if (an === "duration" && bn === "duration" && (op === "+" || op === "-")) {
      return { kind: "primitive", name: "duration" };
    }
    if (
      op === "*" &&
      ((an === "duration" && bn === "int") || (an === "int" && bn === "duration"))
    ) {
      return { kind: "primitive", name: "duration" };
    }
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
    // `currentUser.orgPath` — the derived tenant materialized-path member
    // (multi-tenancy Phase 2, P2.1).  Not a `user {}` claim; computed per
    // backend from the tenancy claim, typed as the DataKey path (a string).
    if (name === PRINCIPAL_ORG_PATH || name === PRINCIPAL_ROOT_ORG)
      return { kind: "primitive", name: "string" };
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
      case "sortBy":
      case "distinct":
      case "take":
      case "skip":
        return t;
      case "join":
        return { kind: "primitive", name: "string" };
      case "first":
        return t.element;
      case "firstOrNull":
        return { kind: "optional", inner: t.element };
      // `min`/`max` project to an optional of the element type (the call
      // site refines to the lambda-body type).
      case "min":
      case "max":
        return { kind: "optional", inner: t.element };
      default:
        return { kind: "primitive", name: "string" };
    }
  }
  if (t.kind === "entity") {
    const target = findEntityByName(env, t.name);
    if (target) return memberOnEntity(target, name);
    // Applier / workflow-command event params carry the event name as an
    // entity marker — fall back to the event's field set when it isn't an
    // aggregate/part.
    const event = findEventByName(env, t.name);
    if (event) return memberOnEvent(event, name);
    // Workflow command params may be payload-typed (`handle h(c: SettleOrder)`),
    // also entity-marked — fall back to the payload's flat field set.
    const payload = findPayloadByName(env, t.name);
    if (payload) return memberOnPayload(payload, name);
    // A workflow `this`/correlation is also entity-marked — fall back to its
    // state fields (workflow-and-applier.md A2).
    const wf = findWorkflowByName(env, t.name);
    if (wf) return memberOnWorkflow(wf, name);
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
  if (t.kind === "primitive") {
    // Scalar intrinsics (src/util/intrinsics.ts) — catalogue-driven.
    const sig = intrinsicFor(t.name, name);
    if (sig) {
      const ret = intrinsicReturnType(sig, t.name);
      if (ret.endsWith("[]")) {
        return {
          kind: "array",
          element: { kind: "primitive", name: ret.slice(0, -2) as PrimitiveName },
        };
      }
      return { kind: "primitive", name: ret as PrimitiveName };
    }
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
    const idValue: IdValueType = isAggregate(target) ? ("guid" as IdValueType) : "guid";
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

/** Member type on an applier's event parameter (`apply(e: E) { … e.f … }`).
 *  An event is a flat payload of `Property` fields (`event E { f: T, … }`),
 *  so resolution is field-only — no `id`, containment, or derived members. */
function memberOnEvent(event: EventDecl, name: string): TypeIR {
  for (const f of event.fields) {
    if (f.name === name) return lowerType(f.type);
  }
  return { kind: "primitive", name: "string" };
}

/** Member type on a workflow command's payload parameter (`handle h(c: C) { …
 *  c.f … }`).  A payload is a flat record of `Property` fields (`command C { f:
 *  T, … }`), so resolution is field-only — the transport-layer twin of
 *  `memberOnEvent`. */
function memberOnPayload(payload: PayloadDecl, name: string): TypeIR {
  for (const f of payload.fields) {
    if (f.name === name) return lowerType(f.type);
  }
  return { kind: "primitive", name: "string" };
}

/** Member type on a workflow `this`/correlation reference — resolution against
 *  the workflow's `Property` state fields (workflow-and-applier.md A2).  Like
 *  `memberOnEvent`, field-only: workflow state has no containment / derived /
 *  function members today. */
function memberOnWorkflow(wf: Workflow, name: string): TypeIR {
  for (const m of wf.members) {
    if (isProperty(m) && m.name === name) return lowerType(m.type);
  }
  return { kind: "primitive", name: "string" };
}

function memberOnProjection(proj: Projection, name: string): TypeIR {
  for (const m of proj.members) {
    if (isProperty(m) && m.name === name) return lowerType(m.type);
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
  else if (env.workflow) cur = memberOnWorkflow(env.workflow, head);
  else if (env.projection) cur = memberOnProjection(env.projection, head);
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
    if (name === PRINCIPAL_ORG_PATH || name === PRINCIPAL_ROOT_ORG)
      return { kind: "primitive", name: "string" };
    const f = env.user.fields.find((f) => f.name === name);
    if (f) return f.optional ? { kind: "optional", inner: f.type } : f.type;
    return { kind: "primitive", name: "string" };
  }
  if (t.kind === "entity") {
    const target = findEntityByName(env, t.name);
    if (target) return memberOnEntity(target, name);
    const event = findEventByName(env, t.name);
    if (event) return memberOnEvent(event, name);
    const payload = findPayloadByName(env, t.name);
    if (payload) return memberOnPayload(payload, name);
    const wf = findWorkflowByName(env, t.name);
    if (wf) return memberOnWorkflow(wf, name);
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
