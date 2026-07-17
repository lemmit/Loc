// Operation-body statement checks: assign / collection-mutate / call,
// emit, requires / precondition / let.  Plus the `lvalueType` and
// `lvalueIsDerived` helpers that target type-resolution / derived-
// rejection logic on the lhs of an assignment.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import type {
  Aggregate,
  AssignOrCallStmt,
  BuilderCall,
  Create,
  Destroy,
  EmitStmt,
  Expression,
  FunctionDecl,
  LValue,
  Model,
  Operation,
  Parameter,
  Statement,
} from "../generated/ast.js";
import {
  isAssignOrCallStmt,
  isCallSuffix,
  isDerivedProp,
  isEmitStmt,
  isFunctionDecl,
  isLetStmt,
  isMemberSuffix,
  isModel,
  isNameRef,
  isOperation,
  isPostfixChain,
  isPreconditionStmt,
  isRequiresStmt,
  isRetrievalLiteral,
  isThisRef,
} from "../generated/ast.js";
import {
  type DddType,
  type Env,
  findFunction,
  findOperation,
  freeCallFunction,
  isAssignable,
  lookupRootMember,
  makeEnv,
  paramType,
  propertySensitivity,
  resolveTypeRef,
  stepInto,
  stepIntoNode,
  T,
  typeOf,
  typeToString,
  withTags,
} from "../type-system.js";
import {
  canPromoteLiteralTo,
  envForAggregate,
  pathString,
  warnSensitivityDrop,
} from "./_shared.js";
import { recordFieldTypes, resolveRecordDecl } from "./builder-call.js";

/** An aggregate action whose body reuses operation-body statement
 * rules: today's `operation`, plus the lifecycle `create` / `destroy`
 * keywords.  Body type-checking is identical across the three. */
type ActionLike = Operation | Create | Destroy;

export function checkOperation(op: Operation, agg: Aggregate, accept: ValidationAcceptor): void {
  // `audited` instruments the operation's HTTP route handler; a private
  // operation has no route, so the modifier produces no audit record.
  if (op.audited && op.private) {
    accept(
      "warning",
      `'audited' has no effect on private operation '${op.name}' — it has no HTTP entry point, so no audit record is produced.`,
      { node: op, property: "audited" },
    );
  }

  // `when Expr` (canCommand state gate, criterion.md use site 2): a pure
  // bool predicate over the aggregate's OWN state.  It type-checks in the
  // aggregate env — operation parameters are deliberately out of scope
  // (the NakedObjects-style split: arg-aware checks go through
  // `from <Criterion>(args)` on the parameters, not through `when`).
  if (op.when) {
    const paramNames = new Set(op.params.map((p) => p.name));
    for (const node of AstUtils.streamAst(op.when)) {
      const name = (node as { $type: string; name?: string }).name;
      if (node.$type === "NameRef" && name !== undefined && paramNames.has(name)) {
        accept(
          "error",
          `'when' on operation '${op.name}' references parameter '${name}' — a 'when' gate is a predicate over the aggregate's state only (its can-${op.name} query has no arguments). Move argument-aware checks into a 'precondition' in the body.`,
          { node: op, property: "when" },
        );
      }
    }
    const t = typeOf(op.when, envForAggregate(agg));
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept("error", `'when' must be of type 'bool', got '${typeToString(t)}'.`, {
        node: op,
        property: "when",
      });
    }
    if (op.private) {
      accept(
        "warning",
        `'when' has no effect on private operation '${op.name}' — it has no HTTP entry point, so no gate or can-${op.name} query is emitted.`,
        { node: op, property: "when" },
      );
    }
  }

  // Build env with parameters and walk body
  const bindings = new Map<string, { type: DddType; origin: AstNode }>();
  for (const p of op.params) bindings.set(p.name, { type: paramType(p), origin: p });
  let env: Env = makeEnv(envForAggregate(agg), bindings, { aggregate: agg });

  for (const stmt of op.body) {
    env = checkStatement(stmt, agg, op, env, accept);
  }
}

/** Shared body type-check for the lifecycle `create` / `destroy`
 * keywords — binds params, walks the body through the same statement
 * checks as `operation`.  The kind tag carries the lifecycle
 * asymmetry; the body discipline is identical. */
function checkActionBody(node: Create | Destroy, agg: Aggregate, accept: ValidationAcceptor): void {
  const bindings = new Map<string, { type: DddType; origin: AstNode }>();
  for (const p of node.params) bindings.set(p.name, { type: paramType(p), origin: p });
  let env: Env = makeEnv(envForAggregate(agg), bindings, { aggregate: agg });
  for (const stmt of node.body) {
    env = checkStatement(stmt, agg, node, env, accept);
  }
}

export function checkCreate(c: Create, agg: Aggregate, accept: ValidationAcceptor): void {
  checkActionBody(c, agg, accept);
  // `this.id` is unassigned inside a create body — the id is allocated
  // at persistence, after the body runs, so reading it has no defined
  // semantics (lifecycle-operations.md, body rule 2).
  for (const node of AstUtils.streamAllContents(c)) {
    if (!isPostfixChain(node) || !isThisRef(node.head)) continue;
    const first = node.suffixes[0];
    if (first && isMemberSuffix(first) && first.member === "id") {
      accept(
        "error",
        `Cannot read 'this.id' inside the create action on aggregate '${agg.name}' — the id is not assigned until persistence, after the body runs.`,
        { node: first, property: "member", code: "loom.this-id-in-create" },
      );
    }
  }
}

export function checkDestroy(d: Destroy, agg: Aggregate, accept: ValidationAcceptor): void {
  checkActionBody(d, agg, accept);
}

/** Model-wide: an anonymous retrieval literal's `where:` must be a criterion
 *  reference in this release (`ActiveOrder` / `InRegion(r)`) — composed or
 *  inline predicates are a follow-up (criterion.md, use site 3).  Streams every
 *  `RetrievalLiteral` so it fires wherever one appears. */
export function checkRetrievalLiteral(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isRetrievalLiteral(node)) continue;
    const w = node.where;
    const isCriterionRef =
      isNameRef(w) ||
      (isPostfixChain(w) &&
        isNameRef(w.head) &&
        w.suffixes.length === 1 &&
        isCallSuffix(w.suffixes[0]));
    if (!isCriterionRef) {
      accept(
        "error",
        "an anonymous retrieval's 'where:' must be a criterion reference (e.g. 'ActiveOrder' or 'InRegion(r)') in this release.",
        { node, property: "where" },
      );
    }
  }
}

export function checkStatement(
  stmt: Statement,
  agg: Aggregate,
  op: ActionLike,
  env: Env,
  accept: ValidationAcceptor,
): Env {
  // Type-check any record construction reachable from this statement's
  // expressions (`price := Coin { amount: … }`, emit-field values, nested
  // constructions) against the record's declared field types.  Every
  // sub-expression of the statement shares this incoming env — a `let`'s own
  // value can't reference the binding it introduces, and later statements get
  // the extended env passed in.
  checkConstructionArgTypes(stmt, env, accept);
  checkExprCallArgs(stmt, env, accept);
  if (isPreconditionStmt(stmt)) {
    const t = typeOf(stmt.expr, env);
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept("error", `'precondition' must be of type 'bool', got '${typeToString(t)}'.`, {
        node: stmt,
        property: "expr",
      });
    }
    return env;
  }
  if (isRequiresStmt(stmt)) {
    const t = typeOf(stmt.expr, env);
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept("error", `'requires' must be of type 'bool', got '${typeToString(t)}'.`, {
        node: stmt,
        property: "expr",
      });
    }
    return env;
  }
  if (isLetStmt(stmt)) {
    const t = typeOf(stmt.expr, env);
    const next = new Map<string, { type: DddType; origin: AstNode }>();
    next.set(stmt.name, { type: t, origin: stmt });
    return makeEnv(env, next);
  }
  if (isEmitStmt(stmt)) {
    checkEmit(stmt, env, accept);
    return env;
  }
  if (isAssignOrCallStmt(stmt)) {
    checkAssignOrCall(stmt, agg, op, env, accept);
    return env;
  }
  return env;
}

export function checkAssignOrCall(
  stmt: AssignOrCallStmt,
  agg: Aggregate,
  op: ActionLike,
  env: Env,
  accept: ValidationAcceptor,
): void {
  if (!stmt.op) {
    // Bare call statement
    checkCallStmt(stmt, agg, op, env, accept);
    return;
  }
  const targetType = lvalueType(stmt.target, agg, env, accept);
  // Reject assignment to a derived property — derived members are
  // computed from other state and writing to them would silently no-op.
  if (lvalueIsDerived(stmt.target, agg)) {
    accept("error", `Cannot assign to derived property '${pathString(stmt.target)}'.`, {
      node: stmt,
      property: "target",
    });
    return;
  }
  if (stmt.op === ":=") {
    const valueType = typeOf(stmt.value, env);
    if (
      targetType.kind !== "unknown" &&
      valueType.kind !== "unknown" &&
      !isAssignable(valueType, targetType) &&
      !canPromoteLiteralTo(stmt.value, targetType)
    ) {
      accept(
        "error",
        `Cannot assign '${typeToString(valueType)}' to '${typeToString(targetType)}'.`,
        { node: stmt, property: "value" },
      );
    }
    warnSensitivityDrop(valueType, targetType, accept, { node: stmt, property: "value" });
  } else {
    // '+=' or '-='
    if (targetType.kind !== "array") {
      accept(
        "error",
        `'${stmt.op}' requires a collection on the left-hand side, got '${typeToString(targetType)}'.`,
        { node: stmt, property: "target" },
      );
      return;
    }
    const valueType = typeOf(stmt.value, env);
    if (
      targetType.element.kind !== "unknown" &&
      valueType.kind !== "unknown" &&
      !isAssignable(valueType, targetType.element)
    ) {
      accept(
        "error",
        `Cannot ${stmt.op === "+=" ? "add" : "remove"} element of type '${typeToString(valueType)}' to/from collection of '${typeToString(targetType.element)}'.`,
        { node: stmt, property: "value" },
      );
    }
    warnSensitivityDrop(valueType, targetType.element, accept, {
      node: stmt,
      property: "value",
    });
  }
}

/** Entry-VALUE type check for record construction (`X { field: value, … }`)
 *  reachable from an operation / create / destroy body — the type-checking twin
 *  of `checkConstructionFields` (which validates entry NAMES model-wide without
 *  an env).  Value typing needs the lexical `Env`, so it hooks into the
 *  statement walk here rather than at the model-stream level.  Streams every
 *  `BuilderCall` descendant of the statement (nested constructions included) and
 *  checks each named entry's value type against the record's declared field type,
 *  mirroring `checkEmit`: suppress on `unknown` (a typo'd bare name is reported
 *  once at its source by `checkUnknownNameRefs`, not doubly here) and admit
 *  numeric-literal promotion (`amount: 5` into a `money`/`decimal` field) exactly
 *  as `checkEmit` / `:=` do.  A construction inside a binding lambda types its
 *  lambda-bound refs as `unknown` under this body env → suppressed (skipped, not
 *  false-flagged). */
export function checkConstructionArgTypes(
  node: AstNode,
  env: Env,
  accept: ValidationAcceptor,
): void {
  for (const n of AstUtils.streamAst(node)) {
    if (n.$type !== "BuilderCall") continue;
    const bc = n as BuilderCall;
    const model = AstUtils.getContainerOfType(bc, isModel);
    if (!model) continue;
    const decl = resolveRecordDecl(bc, model);
    if (!decl) continue; // primitive / component / unknown — not a record
    const types = recordFieldTypes(decl);
    for (const entry of bc.entries) {
      // Positional entries (no name) and unknown field NAMES are
      // `checkConstructionFields`'s concern, not this value check.
      if (typeof entry.name !== "string") continue;
      const expected = types.get(entry.name);
      if (!expected || expected.kind === "unknown") continue;
      const actual = typeOf(entry.value, env);
      if (
        actual.kind !== "unknown" &&
        !isAssignable(actual, expected) &&
        !canPromoteLiteralTo(entry.value, expected)
      ) {
        accept(
          "error",
          `Field '${entry.name}' of '${bc.type}' expects '${typeToString(expected)}' but got '${typeToString(actual)}'.`,
          { node: entry, property: "value", code: "loom.construction-field-type" },
        );
      }
      warnSensitivityDrop(actual, expected, accept, { node: entry, property: "value" });
    }
  }
}

/** Arity + type check for FREE calls in EXPRESSION position (`derived x =
 *  fee(a)`, `let y := compute(a, b)`, `precondition check(a)`, `emit E { f:
 *  fee(3) }`) — the expression-walk companion to `checkCallStmt`'s statement-call
 *  check (M-T6.18 gap #2).  Streams every free-call `PostfixChain` (a bare
 *  `NameRef` head with a leading `CallSuffix`) reachable from `node`; when the
 *  name resolves to a user `FunctionDecl` (via `freeCallFunction`, kept in
 *  lockstep with `typeOfFreeCall`) its args are checked through the shared
 *  `checkCallArgs`.  Everything else is deliberately skipped: value-object
 *  constructors, criteria, policy-fns, and duration builtins aren't free
 *  user-function calls (or have their own gates), and member calls
 *  (`recv.m(a)`) — a `MemberSuffix`, not a leading `CallSuffix` — are the
 *  follow-on slice.  Bare call STATEMENTS (`fee(5)` alone) are an `LValue`, not a
 *  `PostfixChain`, so they stay `checkCallStmt`'s job with no double report. */
export function checkExprCallArgs(node: AstNode, env: Env, accept: ValidationAcceptor): void {
  for (const n of AstUtils.streamAst(node)) {
    if (!isPostfixChain(n)) continue;
    const first = n.suffixes[0];
    if (!first || !isCallSuffix(first) || !isNameRef(n.head)) continue;
    const fn = freeCallFunction(n.head.name, env);
    if (!fn) continue; // VO ctor / criterion / policy-fn / duration builtin / unresolved
    const args = first.args.map((a) => a.value);
    checkCallArgs(fn.params, args, env, `Function '${n.head.name}'`, first, accept);
  }
}

export function checkEmit(stmt: EmitStmt, env: Env, accept: ValidationAcceptor): void {
  const ev = stmt.event?.ref;
  if (!ev) return;
  // Capture the event-field's declared sensitivity so PII flowing
  // into a clean event-field surfaces as a narrowing warning — events
  // fan out across consumers, so this is the highest-leverage place
  // to flag PII fan-out.
  const declared = new Map(
    ev.fields.map(
      (f) => [f.name, withTags(resolveTypeRef(f.type), propertySensitivity(f))] as const,
    ),
  );
  const seen = new Set<string>();
  for (const f of stmt.fields) {
    seen.add(f.name);
    const expected = declared.get(f.name);
    if (!expected) {
      accept("error", `Event '${ev.name}' has no field '${f.name}'.`, {
        node: f,
        property: "name",
      });
      continue;
    }
    const actual = typeOf(f.value, env);
    // Suppress on `unknown` like the sibling gates (`checkAssignOrCall`,
    // `checkDerived`, …): an unresolvable value (e.g. a typo'd bare name)
    // is reported once at its source by `checkUnknownNameRefs` /
    // `checkUnknownMemberAccess`.  Without this guard `checkEmit` was the
    // only typo catch in emit args, and it produced a second, misleading
    // "expects X but got unknown" error (finding 1 / A2.2).
    // Admit literal promotion (`amount: 5` into a `money` field) exactly as
    // `checkPropertyDefault` / `checkDerived` / `:=` do — otherwise emit args
    // reject the same ergonomic numeric-literal forms defaults accept (C1).
    if (
      actual.kind !== "unknown" &&
      !isAssignable(actual, expected) &&
      !canPromoteLiteralTo(f.value, expected)
    ) {
      accept(
        "error",
        `Field '${f.name}' expects '${typeToString(expected)}' but got '${typeToString(actual)}'.`,
        { node: f, property: "value" },
      );
    }
    warnSensitivityDrop(actual, expected, accept, { node: f, property: "value" });
  }
  for (const [name] of declared) {
    if (!seen.has(name)) {
      accept("warning", `Event field '${name}' not provided.`, {
        node: stmt,
        property: "event",
      });
    }
  }
}

/** Arity + per-argument type check for a resolved domain call (`bump("hi")`,
 *  `o.bump(a)`) — the statement-call twin of `checkAsyncEffectArgs` / `checkEmit`
 *  (M-T6.18 gap #2).  The callee is already resolved to an operation / function
 *  with a fixed, all-required param list (the grammar has no optional/defaulted
 *  params), so the discipline mirrors the sibling gates: strict arity, then
 *  per-arg `isAssignable` with `unknown`-suppression (a typo'd bare arg is
 *  reported once at its source) + numeric-literal promotion (`bump(5)` into a
 *  `money`/`decimal` param).  On an arity mismatch we stop before the per-arg
 *  loop — the positions no longer line up, so per-arg type errors would be
 *  noise. */
function checkCallArgs(
  params: Parameter[],
  args: Expression[],
  env: Env,
  label: string,
  node: AstNode,
  accept: ValidationAcceptor,
): void {
  if (args.length !== params.length) {
    accept(
      "error",
      `${label} expects ${params.length} argument${params.length === 1 ? "" : "s"}, got ${args.length}.`,
      { node, code: "loom.call-arg-count" },
    );
    return;
  }
  for (let i = 0; i < args.length; i++) {
    const expected = paramType(params[i]!);
    if (expected.kind === "unknown") continue;
    const actual = typeOf(args[i], env);
    if (
      actual.kind !== "unknown" &&
      !isAssignable(actual, expected) &&
      !canPromoteLiteralTo(args[i], expected)
    ) {
      accept(
        "error",
        `Argument ${i + 1} of ${label} expects '${typeToString(expected)}' but got '${typeToString(actual)}'.`,
        { node: args[i]!, code: "loom.call-arg-type" },
      );
    }
  }
}

export function checkCallStmt(
  stmt: AssignOrCallStmt,
  agg: Aggregate,
  op: ActionLike,
  env: Env,
  accept: ValidationAcceptor,
): void {
  const lv = stmt.target;
  if (lv.tail.length === 0 && lv.call) {
    const name = lv.head;
    const fn = findFunction(agg, name);
    if (fn) {
      checkCallArgs(fn.params, lv.args, env, `Function '${name}'`, stmt, accept);
      return;
    }
    const target = findOperation(agg, name);
    if (target) {
      if (target === op) {
        accept("warning", `Operation '${name}' calls itself.`, { node: stmt });
      }
      checkCallArgs(target.params, lv.args, env, `Operation '${name}'`, stmt, accept);
      return;
    }
    accept("error", `Cannot resolve call to '${name}' from aggregate '${agg.name}'.`, {
      node: stmt,
    });
    return;
  }
  if (lv.call) {
    // Member-call statement (`recv.method(args)`, tail.length >= 1).  Neither
    // branch above fired, so without this the chain skipped all validation and
    // an unknown/non-callable member emitted doubly-broken code (C3).  Resolve
    // the receiver through the data segments, then require the final segment to
    // name a callable operation/function on that type.
    const headSym = env.resolve(lv.head);
    const recv0: DddType = headSym ? headSym.type : lookupRootMember(agg, lv.head);
    // When the head isn't a value receiver (a param / let / aggregate member)
    // it names a domain service, criterion, external, or other dotted-call
    // form (`AccountReset.reset(this)`) whose resolution lives elsewhere —
    // leave those to their own checks rather than mis-reporting the head.
    if (recv0.kind === "unknown") return;
    let recv: DddType = recv0;
    for (let i = 0; i < lv.tail.length - 1; i++) {
      recv = stepInto(recv, lv.tail[i]!);
      if (recv.kind === "unknown") {
        accept("error", `Cannot resolve member '${lv.tail[i]}'.`, { node: lv });
        return;
      }
    }
    const methodName = lv.tail[lv.tail.length - 1]!;
    const memberNode = stepIntoNode(recv, methodName);
    if (!memberNode) {
      accept("error", `Cannot resolve member '${methodName}' on type '${typeToString(recv)}'.`, {
        node: lv,
      });
      return;
    }
    if (!isOperation(memberNode) && !isFunctionDecl(memberNode)) {
      accept(
        "error",
        `Member '${methodName}' is not callable — only operations and functions can be called.`,
        { node: lv },
      );
      return;
    }
    checkCallArgs(
      (memberNode as Operation | FunctionDecl).params,
      lv.args,
      env,
      `'${methodName}'`,
      lv,
      accept,
    );
    return;
  }
  accept(
    "error",
    `Bare statement must be an assignment, collection mutation, or function/operation call.`,
    { node: stmt },
  );
}

export function lvalueType(
  lv: LValue,
  agg: Aggregate,
  env: Env,
  accept: ValidationAcceptor,
): DddType {
  // Resolve the head: a parameter, let-binding, or an aggregate property.
  const headSym = env.resolve(lv.head);
  let cur: DddType;
  if (headSym) {
    cur = headSym.type;
  } else {
    // Check aggregate root members
    cur = lookupRootMember(agg, lv.head);
    if (cur.kind === "unknown") {
      accept("error", `Cannot resolve '${lv.head}'.`, { node: lv, property: "head" });
      return T.unknown;
    }
  }
  for (const seg of lv.tail) {
    cur = stepInto(cur, seg);
    if (cur.kind === "unknown") {
      accept("error", `Cannot resolve member '${seg}'.`, { node: lv });
      return T.unknown;
    }
  }
  return cur;
}

/**
 * True if the lvalue's *final* segment names a derived member of the
 * type reachable via the path so far.  Derived members are computed
 * from state and cannot be assigned to.
 */
export function lvalueIsDerived(lv: LValue, agg: Aggregate): boolean {
  if (lv.tail.length === 0) {
    // Direct head reference — check root members
    for (const m of agg.members) {
      if (isDerivedProp(m) && m.name === lv.head) return true;
    }
    return false;
  }
  // Walk the path, last segment matters
  let cur: DddType = lookupRootMember(agg, lv.head);
  for (let i = 0; i < lv.tail.length - 1; i++) {
    cur = stepInto(cur, lv.tail[i]!);
  }
  const lastSegment = lv.tail[lv.tail.length - 1]!;
  if (cur.kind === "entity" || cur.kind === "aggregate") {
    for (const m of cur.ref.members) {
      if (isDerivedProp(m) && m.name === lastSegment) return true;
    }
  }
  if (cur.kind === "valueobject") {
    for (const m of cur.ref.members) {
      if (isDerivedProp(m) && m.name === lastSegment) return true;
    }
  }
  return false;
}
