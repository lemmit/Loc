// Operation-body statement checks: assign / collection-mutate / call,
// emit, requires / precondition / let.  Plus the `lvalueType` and
// `lvalueIsDerived` helpers that target type-resolution / derived-
// rejection logic on the lhs of an assignment.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import type {
  Aggregate,
  AssignOrCallStmt,
  Create,
  Destroy,
  EmitStmt,
  LValue,
  Model,
  Operation,
  Statement,
} from "../generated/ast.js";
import {
  isAssignOrCallStmt,
  isDerivedProp,
  isEmitStmt,
  isLetStmt,
  isMemberSuffix,
  isPostfixChain,
  isPreconditionStmt,
  isRequiresStmt,
  isThisRef,
} from "../generated/ast.js";
import {
  type DddType,
  type Env,
  findFunction,
  findOperation,
  isAssignable,
  lookupRootMember,
  makeEnv,
  paramType,
  propertySensitivity,
  resolveTypeRef,
  stepInto,
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
      if (
        (node.$type === "NameRef" || node.$type === "ThisRef") &&
        name !== undefined &&
        paramNames.has(name)
      ) {
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

/** `<Repo>.findAll(...)` — the only `let` binding that admits `sort:` / `loads:`
 *  shaping clauses (`Repo.find` is single-result, no shaping). */
function isFindAllExpr(expr: AstNode | undefined): boolean {
  if (!expr || !isPostfixChain(expr) || expr.suffixes.length !== 1) return false;
  const s = expr.suffixes[0];
  return !!s && isMemberSuffix(s) && !!s.call && s.member === "findAll";
}

/** Model-wide: `sort:` / `loads:` shaping clauses (criterion.md, use site 3)
 *  are only meaningful on a `Repo.findAll(<Criterion>)` binding — they ride the
 *  synthesised retrieval.  On any other `let` they would be silently dropped,
 *  so reject them.  Streams every `LetStmt` (workflow / operation / lifecycle
 *  bodies alike) since the per-body `checkStatement` walk doesn't reach
 *  workflow bodies. */
export function checkLetShaping(model: Model, accept: ValidationAcceptor): void {
  for (const stmt of AstUtils.streamAllContents(model)) {
    if (!isLetStmt(stmt)) continue;
    if ((stmt.sort.length > 0 || stmt.loads.length > 0) && !isFindAllExpr(stmt.expr)) {
      accept(
        "error",
        "'sort:' / 'loads:' clauses are only allowed on a 'Repo.findAll(<Criterion>)' binding.",
        { node: stmt, property: stmt.sort.length > 0 ? "sort" : "loads" },
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
    checkCallStmt(stmt, agg, op, accept);
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
    if (!isAssignable(actual, expected)) {
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

export function checkCallStmt(
  stmt: AssignOrCallStmt,
  agg: Aggregate,
  op: ActionLike,
  accept: ValidationAcceptor,
): void {
  const lv = stmt.target;
  if (lv.tail.length === 0 && lv.call) {
    const name = lv.head;
    const fn = findFunction(agg, name);
    if (fn) return;
    const target = findOperation(agg, name);
    if (target) {
      if (target === op) {
        accept("warning", `Operation '${name}' calls itself.`, { node: stmt });
      }
      return;
    }
    accept("error", `Cannot resolve call to '${name}' from aggregate '${agg.name}'.`, {
      node: stmt,
    });
  } else if (!lv.call) {
    accept(
      "error",
      `Bare statement must be an assignment, collection mutation, or function/operation call.`,
      { node: stmt },
    );
  }
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
