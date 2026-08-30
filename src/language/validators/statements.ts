// Operation-body statement checks: assign / collection-mutate / call,
// emit, requires / precondition / let.  Plus the `lvalueType` and
// `lvalueIsDerived` helpers that target type-resolution / derived-
// rejection logic on the lhs of an assignment.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import type {
  ActionDecl,
  Aggregate,
  AssignOrCallStmt,
  BuilderCall,
  Component,
  Create,
  Criterion,
  Destroy,
  EmitStmt,
  Expression,
  FindDecl,
  FunctionDecl,
  LValue,
  Model,
  Operation,
  Parameter,
  PolicyDecl,
  Retrieval,
  Statement,
  Store,
} from "../generated/ast.js";
import {
  isActionDecl,
  isAssignOrCallStmt,
  isCallSuffix,
  isComponent,
  isCriterion,
  isDerivedProp,
  isEmitStmt,
  isFindDecl,
  isFunctionDecl,
  isLetStmt,
  isMemberSuffix,
  isModel,
  isNameRef,
  isOperation,
  isPolicyDecl,
  isPostfixChain,
  isPreconditionStmt,
  isRequiresStmt,
  isRetrieval,
  isRetrievalLiteral,
  isStore,
  isThisRef,
  isUi,
} from "../generated/ast.js";
import {
  type DddType,
  type Env,
  envForNode,
  findFunction,
  findOperation,
  freeCallFunction,
  freeCallPredicate,
  isAssignable,
  lookupRootMember,
  makeEnv,
  paramType,
  propertySensitivity,
  resolveTypeRef,
  stepInto,
  stepIntoNode,
  T,
  typeAfterSuffix,
  typeOf,
  typeToString,
  withTags,
} from "../type-system.js";
import { isWalkerPrimitive } from "../walker-stdlib.js";
import {
  canPromoteLiteralTo,
  checkBlankMessage,
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
      // The gate itself DOES still run — since M-T6.38 / D-WHEN-GATE-DOMAIN the
      // `when` predicate is emitted at the domain-method entry on every
      // backend, so an in-system caller (a workflow step, another domain
      // method) is refused.  What a private operation loses is the HTTP
      // surface: no route to gate, and no `can-<op>` companion for a UI to
      // read.  The warning says exactly that, and no more.
      accept(
        "warning",
        `'when' on private operation '${op.name}' gates the domain method but exposes nothing — a private operation has no HTTP entry point, so no can-${op.name} query is emitted for a UI to read the gate.`,
        { node: op, property: "when" },
      );
    }
  }

  // Build env with parameters and walk body
  const bindings = new Map<string, { type: DddType; origin: AstNode }>();
  for (const p of op.params) bindings.set(p.name, { type: paramType(p), origin: p });
  let env: Env = makeEnv(envForAggregate(agg), bindings, { aggregate: agg });

  // `requires Expr` — the authorization gate (authorization.md §11.3): a bool
  // pre-check (403) over `currentUser` + the operation params + the loaded
  // `this` resource.  Unlike `when`, params ARE in scope (an authz decision is
  // routinely arg-aware).  It types to bool exactly like an in-body `requires`
  // statement (which is what it lowers to); a non-bool gate is rejected here.
  if (op.gate) {
    const gt = typeOf(op.gate, env);
    if (gt.kind !== "primitive" || gt.name !== "bool") {
      accept("error", `'requires' must be of type 'bool', got '${typeToString(gt)}'.`, {
        node: op,
        property: "gate",
      });
    }
    if (op.private) {
      accept(
        "warning",
        `'requires' has no effect on private operation '${op.name}' — it has no HTTP entry point, so no authorization gate is emitted.`,
        { node: op, property: "gate" },
      );
    }
  }

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
      accept("error", diagMessage("loom.this-id-in-create", { name: agg.name }), {
        node: first,
        property: "member",
        code: "loom.this-id-in-create",
      });
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
    checkBlankMessage(stmt, stmt.message, accept);
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
  node: AstNode | undefined,
  env: Env,
  accept: ValidationAcceptor,
): void {
  // Parse recovery leaves grammar-required expression slots undefined; the
  // Langium stream throws ("Root node must be an AstNode") on one, which would
  // abort the enclosing check and swallow its sibling diagnostics.
  if (!node) return;
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
          diagMessage("loom.construction-field-type", {
            name: entry.name,
            type: bc.type,
            expected: typeToString(expected),
            actual: typeToString(actual),
          }),
          { node: entry, property: "value", code: "loom.construction-field-type" },
        );
      }
      warnSensitivityDrop(actual, expected, accept, { node: entry, property: "value" });
    }
  }
}

/** Arity + type check for calls in EXPRESSION position (`derived x = fee(a)`,
 *  `let y := compute(a, b)`, `precondition check(a)`, `derived t = price.scaled(f)`)
 *  — the expression-walk companion to `checkCallStmt`'s statement-call check
 *  (M-T6.18 gap #2).  Streams every `PostfixChain` reachable from `node` and
 *  covers two call shapes:
 *
 *   - **Free call** (`name(args)` — a bare `NameRef` head with a leading
 *     `CallSuffix`): when the name resolves to a user `FunctionDecl` (via
 *     `freeCallFunction`, kept in lockstep with `typeOfFreeCall`).  Value-object
 *     constructors, criteria, policy-fns, and duration builtins resolve to
 *     `undefined` and are skipped — they aren't free user-function calls / have
 *     their own gates.
 *   - **Member call** (`recv.method(args)`): walk the chain's running receiver
 *     type and, at each `MemberSuffix` invocation, resolve the member via
 *     `stepIntoNode`.  It returns a node only for function / operation members of
 *     an entity / aggregate / value object receiver — so collection ops
 *     (`.sum`/`.count`/`.filter` on arrays) and scalar intrinsics (primitive
 *     receivers) resolve to `undefined` and are skipped, no false positives.
 *
 *  Both shapes check through the shared `checkCallArgs` (arity +
 *  `unknown`-suppression + numeric-literal promotion).  Bare call STATEMENTS
 *  (`fee(5)` / `o.f(5)` alone) are an `LValue`, not a `PostfixChain`, so they
 *  stay `checkCallStmt`'s job with no double report. */
export function checkExprCallArgs(
  node: AstNode | undefined,
  env: Env,
  accept: ValidationAcceptor,
): void {
  // Same parse-recovery guard as `checkConstructionArgTypes` above.
  if (!node) return;
  for (const n of AstUtils.streamAst(node)) {
    if (!isPostfixChain(n)) continue;
    const first = n.suffixes[0];
    if (first && isCallSuffix(first) && isNameRef(n.head)) {
      // Free call at the front (`fee(args)`).  Member accesses on its return
      // (`fee(x).bar`) are a niche running-type case we don't chase here.
      const fn = freeCallFunction(n.head.name, env);
      if (fn) {
        checkCallArgs(
          fn.params,
          first.args.map((a) => a.value),
          env,
          `Function '${n.head.name}'`,
          first,
          accept,
        );
      } else {
        // Criterion / policy-function predicate (`InRegion(r)`, `CanApprove(c)`).
        // Its ARITY is already checked model-wide (loom.criterion-arity /
        // checkPolicyFns), so only type-check the args — and only when the arity
        // lines up, to avoid mis-pairing after a separately-reported miscount.
        const predParams = freeCallPredicate(n.head.name, env);
        if (predParams && predParams.length === first.args.length) {
          checkArgTypesPositional(
            predParams,
            first.args.map((a) => a.value),
            env,
            `'${n.head.name}'`,
            accept,
          );
        }
      }
      continue;
    }
    // Member-call chain (`recv.method(args)`): thread the running receiver type.
    let curType: DddType = typeOf(n.head, env);
    for (const s of n.suffixes) {
      if (isMemberSuffix(s) && s.call && curType.kind !== "unknown") {
        const member = stepIntoNode(curType, s.member);
        if (member && (isFunctionDecl(member) || isOperation(member))) {
          checkCallArgs(
            member.params,
            s.args.map((a) => a.value),
            env,
            `'${s.member}'`,
            s,
            accept,
          );
        }
      }
      curType = typeAfterSuffix(curType, s, env);
    }
  }
}

/** M-T6.18 gap #3 — arg-type + construction-value checking at the EXPRESSION
 *  slots the operation/function/default/invariant/derived walk never reaches:
 *  repository `find … where` / `… requires`, retrieval `where:` (named +
 *  anonymous), criterion / policy-fn bodies, and operation `requires` / `when`
 *  gates.  Each holds an `Expression` that can nest a criterion/policy predicate
 *  call, a free/member domain call, or a record construction — all already
 *  type-checkable by the shared `checkExprCallArgs` / `checkConstructionArgTypes`
 *  under the slot's lexical env (`envForNode`, which binds a find's `for`
 *  aggregate + params and an operation's `this` + params).  Predicate-call ARITY
 *  is already model-wide (`loom.criterion-arity` / `loom.policy-fn-arity`); this
 *  adds the per-argument TYPE those gates don't touch, reusing the same
 *  `loom.call-arg-type` / `loom.construction-field-type` codes as the statement
 *  walk.  These seven slots are disjoint from `checkExprCallArgs`'s eight
 *  existing hook points, so no diagnostic is reported twice. */
export function checkPredicateSlotArgs(model: Model, accept: ValidationAcceptor): void {
  const visit = (expr: Expression | undefined): void => {
    if (!expr) return;
    const env = envForNode(expr);
    checkConstructionArgTypes(expr, env, accept);
    checkExprCallArgs(expr, env, accept);
  };
  for (const node of AstUtils.streamAllContents(model)) {
    if (isFindDecl(node)) {
      visit((node as FindDecl).filter);
      visit((node as FindDecl).gate);
    } else if (isRetrieval(node)) {
      visit((node as Retrieval).where);
    } else if (isRetrievalLiteral(node)) {
      visit(node.where);
    } else if (isCriterion(node)) {
      visit((node as Criterion).body);
    } else if (isPolicyDecl(node)) {
      visit((node as PolicyDecl).body);
    } else if (isOperation(node)) {
      visit((node as Operation).gate);
      visit((node as Operation).when);
    }
  }
}

/** Resolve a store-action call `<store>.<action>(args)` to its `ActionDecl`, or
 *  `undefined` when `head` names no store / `action` no action on it.  A store is
 *  a `ui` member referenced by bare name; the enclosing `ui` wins, else any store
 *  of that name in the model (matching the lowering's store index). */
function resolveStoreAction(
  head: string,
  action: string,
  node: AstNode,
  model: Model,
): ActionDecl | undefined {
  const findIn = (store: Store): ActionDecl | undefined =>
    store.decls.find((d): d is ActionDecl => isActionDecl(d) && d.name === action);
  const ui = AstUtils.getContainerOfType(node, isUi);
  if (ui) {
    for (const m of ui.members) {
      if (isStore(m) && m.name === head) {
        const a = findIn(m);
        if (a) return a;
      }
    }
  }
  for (const n of AstUtils.streamAllContents(model)) {
    if (isStore(n) && n.name === head) {
      const a = findIn(n);
      if (a) return a;
    }
  }
  return undefined;
}

/** M-T6.18 gap #3 — arity + per-argument type check for a store-action call
 *  (`Cart.add(42)`).  Page / component / store `action` bodies are never fed to
 *  the statement walk (that fires only for aggregate operations), so a
 *  store-action call had NEITHER its arity NOR its argument types checked — a
 *  wrong count or a `string` into an `int` action param compiled the .ddd and
 *  only failed the emitted frontend.  Both invocation forms are covered: the bare
 *  call STATEMENT (`Cart.add(42)` — an `AssignOrCallStmt` LValue) and the
 *  expression form (a single-suffix `PostfixChain`, e.g. `x := Cart.add(42)`).
 *  Reuses the shared `checkCallArgs` (arity + positional type, `unknown`
 *  suppression, numeric-literal promotion) under the call site's lexical env. */
export function checkStoreActionCallArgs(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    let head: string | undefined;
    let action: string | undefined;
    let args: Expression[] | undefined;
    let argNode: AstNode = node;
    if (isAssignOrCallStmt(node)) {
      const lv = node.target;
      if (!lv.call || lv.tail.length !== 1) continue;
      head = lv.head;
      action = lv.tail[0];
      args = lv.args;
      argNode = lv;
    } else if (isPostfixChain(node)) {
      const h = node.head;
      const s = node.suffixes[0];
      if (!isNameRef(h) || node.suffixes.length !== 1 || !s || !isMemberSuffix(s) || !s.call)
        continue;
      head = h.name;
      action = s.member;
      args = s.args.map((a) => a.value);
      argNode = s;
    } else {
      continue;
    }
    if (head === undefined || action === undefined || args === undefined) continue;
    const decl = resolveStoreAction(head, action, node, model);
    if (!decl) continue; // head names no store / action — not this check's concern
    checkCallArgs(
      decl.params,
      args,
      envForNode(argNode),
      `Store action '${head}.${action}'`,
      argNode,
      accept,
    );
  }
}

/** Resolve a page-body component invocation NAME to its `Component` declaration,
 *  or `undefined` when the name isn't a reachable component.  Mirrors
 *  `checkBuilderCallType`'s component resolution but returns the node (for its
 *  typed params): the enclosing `ui`'s components win, else a top-level component
 *  in the same document.  Cross-document components (workspace index) are skipped
 *  — their params aren't in hand here, so the prop check fails open on them. */
function resolveComponent(name: string, node: AstNode, model: Model): Component | undefined {
  const ui = AstUtils.getContainerOfType(node, isUi);
  if (ui) {
    for (const m of ui.members) if (isComponent(m) && m.name === name) return m;
  }
  for (const m of model.members) if (isComponent(m) && m.name === name) return m;
  return undefined;
}

/** M-T6.18 gap #3 — per-prop type check for a page-body COMPONENT invocation
 *  (`Panel(amount: "x")` / `Panel { amount: "x" }`).  A user `component` declares
 *  typed params, but neither invocation form had its prop VALUES checked — a
 *  `string` into an `int` param compiled the .ddd and only failed the emitted
 *  frontend's tsc.  Both forms are covered: the paren call (`Panel(amount: x)` — a
 *  single-suffix `PostfixChain` `CallSuffix`, positional or named) and the brace
 *  builder (`Panel { amount: x }` — a `BuilderCall`, which record constructions
 *  also use, so a name resolving to a value object / part / payload is left to
 *  `checkConstructionArgTypes`).  `slot`/`action`-typed params carry JSX / a
 *  callback, not a value, so they're skipped; optional / defaulted params need no
 *  arg, so only PROVIDED props are checked. */
export function checkComponentPropTypes(model: Model, accept: ValidationAcceptor): void {
  const checkProps = (
    comp: Component,
    provided: { name?: string; value: Expression | undefined; node: AstNode }[],
    label: string,
  ): void => {
    provided.forEach((arg, i) => {
      const param =
        typeof arg.name === "string"
          ? comp.params.find((p) => p.name === arg.name)
          : comp.params[i];
      if (!param) return; // unknown prop / excess positional — not this check's concern
      const expected = paramType(param);
      // `slot` (JSX child) / `action` (callback) params take no value; a loose
      // `unknown` param type can't be compared.
      if (expected.kind === "slot" || expected.kind === "action" || expected.kind === "unknown")
        return;
      const actual = typeOf(arg.value, envForNode(arg.node));
      if (
        actual.kind !== "unknown" &&
        !isAssignable(actual, expected) &&
        !canPromoteLiteralTo(arg.value, expected)
      ) {
        accept(
          "error",
          diagMessage("loom.component-prop-type", {
            name: param.name,
            label,
            expected: typeToString(expected),
            actual: typeToString(actual),
          }),
          { node: arg.node, property: "value", code: "loom.component-prop-type" },
        );
      }
    });
  };

  for (const node of AstUtils.streamAllContents(model)) {
    // Brace form: `Panel { amount: x }`.  Skip record constructions (VO / part /
    // payload — `checkConstructionArgTypes` owns those) and walker primitives.
    if (node.$type === "BuilderCall") {
      const bc = node as BuilderCall;
      if (isWalkerPrimitive(bc.type) || resolveRecordDecl(bc, model)) continue;
      const comp = resolveComponent(bc.type, bc, model);
      if (!comp) continue;
      checkProps(
        comp,
        bc.entries.map((e) => ({
          name: typeof e.name === "string" ? e.name : undefined,
          value: e.value,
          node: e,
        })),
        `component '${bc.type}'`,
      );
      continue;
    }
    // Paren form: `Panel(amount: x)` / `Panel(x)` — a NameRef head with a single
    // leading CallSuffix.  A name that resolves to a user FUNCTION is a call
    // (`checkExprCallArgs`' job), not a component invocation.
    if (isPostfixChain(node)) {
      const head = node.head;
      const first = node.suffixes[0];
      if (!isNameRef(head) || node.suffixes.length !== 1 || !first || !isCallSuffix(first))
        continue;
      if (freeCallFunction(head.name, envForNode(node))) continue;
      const comp = resolveComponent(head.name, node, model);
      if (!comp) continue;
      checkProps(
        comp,
        first.args.map((a) => ({
          name: typeof a.name === "string" ? a.name : undefined,
          value: a.value,
          node: a,
        })),
        `component '${head.name}'`,
      );
    }
  }
}

/** Arg-check ONE bare member-call statement (`recv.method(args)`) in a workflow
 *  body.  A workflow has no `this` aggregate, so — unlike `checkCallStmt` — the
 *  receiver is resolved ONLY through the body's typed lets / params (`envForNode`,
 *  with the bounded-context anchor that lets `Agg.create({ … })` type as the
 *  aggregate), with no aggregate-root fallback.  The check FAILS OPEN (returns
 *  silently) whenever the receiver, an intermediate segment, or the final member
 *  doesn't resolve to a callable — workflow-body receiver typing is still partial
 *  (a repository-loaded receiver types `unknown`), so a miss must never become a
 *  false positive.  When it all resolves, args are arity/type-checked by the
 *  shared `checkCallArgs`. */
function checkWorkflowMemberCallStmt(lv: LValue, accept: ValidationAcceptor): void {
  const env = envForNode(lv);
  const headSym = env.resolve(lv.head);
  if (!headSym) return; // receiver isn't a typed local (domain service / criterion / …)
  let recv: DddType = headSym.type;
  for (let i = 0; i < lv.tail.length - 1; i++) {
    recv = stepInto(recv, lv.tail[i]!);
    if (recv.kind === "unknown") return;
  }
  const methodName = lv.tail[lv.tail.length - 1]!;
  const memberNode = stepIntoNode(recv, methodName);
  if (!memberNode || (!isOperation(memberNode) && !isFunctionDecl(memberNode))) return;
  checkCallArgs(
    (memberNode as Operation | FunctionDecl).params,
    lv.args,
    env,
    `'${methodName}'`,
    lv,
    accept,
  );
}

/** M-T6.18 gap #3 (follow-on to #2238) — bare operation/function-call STATEMENTS
 *  in a workflow create/handle/on/apply body (`o.bump(x)`).  #2238 wired
 *  `checkConstructionArgTypes` / `checkExprCallArgs` / `checkEmit` into workflow
 *  bodies, but a bare call statement is an `AssignOrCallStmt` LValue (not a
 *  PostfixChain), so `checkExprCallArgs` never sees it and `checkCallStmt` only
 *  runs for aggregate operations (it needs a `this` aggregate a workflow lacks).
 *  Streams the workflow member and arg-checks each MEMBER-call statement; a bare
 *  `name(args)` free call has no `this`/aggregate to resolve against and is left
 *  alone. */
export function checkWorkflowBodyCallStmts(member: AstNode, accept: ValidationAcceptor): void {
  for (const n of AstUtils.streamAst(member)) {
    if (!isAssignOrCallStmt(n)) continue;
    const lv = n.target;
    if (!lv.call || lv.tail.length < 1) continue;
    checkWorkflowMemberCallStmt(lv, accept);
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
/** Per-argument type check (positional, over the overlap of params/args), shared
 *  by the arity-and-type `checkCallArgs` and the type-ONLY predicate path.  Same
 *  discipline as `checkEmit`: suppress on `unknown`, admit numeric-literal
 *  promotion. */
function checkArgTypesPositional(
  params: Parameter[],
  args: Expression[],
  env: Env,
  label: string,
  accept: ValidationAcceptor,
): void {
  const n = Math.min(params.length, args.length);
  for (let i = 0; i < n; i++) {
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
        diagMessage("loom.call-arg-type", {
          i: i + 1,
          label,
          expected: typeToString(expected),
          actual: typeToString(actual),
        }),
        { node: args[i]!, code: "loom.call-arg-type" },
      );
    }
  }
}

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
      diagMessage("loom.call-arg-count", {
        label,
        length: params.length,
        length2: params.length === 1 ? "" : "s",
        argsLength: args.length,
      }),
      { node, code: "loom.call-arg-count" },
    );
    return;
  }
  checkArgTypesPositional(params, args, env, label, accept);
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
