import { AstUtils, type AstNode } from "langium";
import {
  isBoundedContext,
  type Aggregate,
  type AssignOrCallStmt,
  type BoundedContext,
  type DerivedProp,
  type EmitStmt,
  type Expression,
  type FindDecl,
  type ForStmt,
  type FunctionDecl,
  type IfLetStmt,
  type Invariant,
  type MatchStmt,
  type Model,
  type Operation,
  type Parameter,
  type Repository,
  type BinaryChain,
  type Lambda,
  type MatchExpr,
  type MemberSuffix,
  type BuilderCall,
  type ObjectLit,
  type ParenExpr,
  type PostfixChain,
  type Statement,
  type TernaryExpr,
  type UnaryExpr,
  type ValueObject,
  type Workflow,
} from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";
import {
  inAggregate,
  inScopeNames,
  inValueObject,
  newEnv,
  withLocal,
  type Env,
} from "../../../../src/ir/lower/lower-types.js";
import { calleeSignature, envForNode, membersOfType, typeAfterSuffix, typeOf } from "../../../../src/language/type-system.js";
import { applyEdits } from "../edit-engine";
import { buildLinkedModel } from "./linked-doc";
import { parseDdd } from "../parse";
import {
  aggregateBodyParamNames,
  aggregateBodyStatements,
  listBodies,
  listFunctions,
  nestedStmtLists,
  statementAt,
  workflowBodyParamNames,
  workflowBodyStatements,
  type BodyKey,
  type StmtList,
  type StmtPath,
} from "./body";

// Single-expression slots editable by the structured expression editor:
//   function …(): T = <expr>   (FunctionDecl.body)
//   derived n: T   = <expr>    (DerivedProp.expr)
//   invariant <expr> …         (Invariant.expr, addressed by index)
// All live on aggregates / value objects.  Editing splices the new text over
// the expression's CST range and re-parses the whole document to validate.

export type ExprSlot =
  | { kind: "function"; owner: string; name: string }
  | { kind: "derived"; owner: string; name: string }
  | { kind: "invariant"; owner: string; index: number }
  | { kind: "findFilter"; owner: string; name: string }
  // `index` is the TOP-LEVEL statement; `path` (when present) descends from it
  // into a `for` / `if let` / `match` block, so a nested statement's expression
  // is addressable too.  `member` addresses one statement-bearing member of the
  // aggregate (`create`, `destroy:archive`, `apply:Paid`); omitted = the
  // operation named by `op`, so pre-existing slots keep resolving unchanged.
  | {
      kind: "stmtExpr";
      owner: string;
      op: string;
      member?: BodyKey;
      index: number;
      path?: StmtPath;
      field?: number;
    }
  // `member` addresses one statement-bearing workflow member (`handle:confirm`,
  // `on:PaymentReceived`, `apply:OrderPlaced`, `create:Name`); omitted = the
  // primary `create` starter, so pre-existing slots keep resolving unchanged.
  | {
      kind: "wfStmt";
      owner: string;
      member?: BodyKey;
      index: number;
      path?: StmtPath;
      field?: number;
    };

// --- nested-statement addressing -------------------------------------------
//
// A statement slot's full address is `index` followed by `path` — the same
// `StmtAddr` shape `body.ts` splices with.  The option `value` strings the
// picker keys on encode that path after the index, one `/`-separated segment
// per descent step: `b<i>` (a `for` body / the default list), `t<i>` (an
// `if let` then-branch), `e<i>` (an else block), `a<n>.<i>` (match arm `n`).
// So `stmt:confirm:3/b1` is "statement 1 of the loop at top-level statement 3".

const LIST_TAG: Record<"body" | "then" | "else", string> = { body: "b", then: "t", else: "e" };

const stepTag = (list: StmtList | undefined): string =>
  typeof list === "object" ? `a${list.arm}.` : LIST_TAG[list ?? "body"];

/** Encode a descent path into an option-value suffix (empty for the top
 *  level, so an unnested slot keeps its historical `…:<index>` value). */
export function encodeStmtPath(path: StmtPath | undefined): string {
  if (!path || path.length === 0) return "";
  return path.map((s) => `/${stepTag(s.list)}${s.index}`).join("");
}

const STEP = /^(?:(b|t|e)|a(\d+)\.)(\d+)$/;

/** Parse an option-value path suffix back into descent steps — the inverse of
 *  `encodeStmtPath`.  Null (not `[]`) marks a malformed suffix, so a stale
 *  value can't silently resolve to the top-level statement. */
export function decodeStmtPath(encoded: string): StmtPath | null {
  const body = encoded.startsWith("/") ? encoded.slice(1) : encoded;
  if (body === "") return [];
  const out: { index: number; list?: StmtList }[] = [];
  for (const seg of body.split("/")) {
    const m = STEP.exec(seg);
    if (!m) return null;
    const index = Number(m[3]);
    const list: StmtList = m[1] === "t" ? "then" : m[1] === "e" ? "else" : m[1] === "b" ? "body" : { arm: Number(m[2]) };
    out.push({ index, list });
  }
  return out;
}

/** The full `StmtAddr` a statement slot addresses. */
const slotAddr = (index: number, path?: StmtPath): number | StmtPath =>
  path && path.length > 0 ? [{ index }, ...path] : index;

function membersOf(node: AstNode): readonly AstNode[] {
  if (node.$type === "Aggregate") return (node as Aggregate).members;
  if (node.$type === "ValueObject") return (node as ValueObject).members;
  return [];
}

function findOwner(ast: Model, owner: string): AstNode | null {
  for (const n of AstUtils.streamAst(ast)) {
    if ((n.$type === "Aggregate" || n.$type === "ValueObject") && (n as Aggregate | ValueObject).name === owner) {
      return n;
    }
  }
  return null;
}

export function listDerived(node: AstNode): string[] {
  return membersOf(node)
    .filter((m): m is DerivedProp => m.$type === "DerivedProp")
    .map((d) => (d as DerivedProp).name);
}

/** Each invariant's predicate text, indexed in declaration order. */
export function listInvariants(node: AstNode): string[] {
  return membersOf(node)
    .filter((m): m is Invariant => m.$type === "Invariant")
    .map((iv) => printExpr((iv as Invariant).expr));
}

function findOperation(owner: AstNode | null, name: string): Operation | null {
  if (!owner) return null;
  return (membersOf(owner).find((m): m is Operation => m.$type === "Operation" && (m as Operation).name === name) as Operation | undefined) ?? null;
}

// The editable expression a statement slot points at: the predicate of a
// precondition/requires, a `let` value, an assignment's right-hand value, an
// emit field's value (with `field`), or a bare call's argument (with `field`).
function stmtSlotExpr(stmt: Statement, field?: number): Expression | null {
  if (stmt.$type === "PreconditionStmt" || stmt.$type === "RequiresStmt" || stmt.$type === "LetStmt") {
    return (stmt as { expr: Expression }).expr;
  }
  if (stmt.$type === "ReturnStmt") return (stmt as { value: Expression }).value;
  if (stmt.$type === "AssignOrCallStmt") {
    const a = stmt as AssignOrCallStmt;
    if (a.value) return a.value; // assignment right-hand value
    if (field !== undefined) return a.target?.args[field] ?? null; // bare call argument
    return null;
  }
  if (stmt.$type === "EmitStmt" && field !== undefined) {
    return (stmt as EmitStmt).fields[field]?.value ?? null;
  }
  return null;
}

/** Dotted name of an LValue target (`order.confirm`, `balance`). */
function lvalueName(lv: { head: string; tail: string[] }): string {
  return [lv.head, ...lv.tail].join(".");
}

/** Picker label for a non-emit single-expression statement. */
function stmtLabel(stmt: Statement, expr: Expression): string {
  if (stmt.$type === "LetStmt") return `let ${(stmt as { name: string }).name} = ${printExpr(expr)}`;
  if (stmt.$type === "RequiresStmt") return `requires ${printExpr(expr)}`;
  if (stmt.$type === "PreconditionStmt") return `precondition ${printExpr(expr)}`;
  if (stmt.$type === "ReturnStmt") return `return ${printExpr(expr)}`;
  if (stmt.$type === "AssignOrCallStmt") {
    const a = stmt as AssignOrCallStmt;
    return `${a.target?.$cstNode?.text ?? ""} ${a.op ?? "="} ${printExpr(expr)}`;
  }
  return printExpr(expr);
}

/** Label fragment for one descent step, so a nested option reads
 *  `confirm: body › total += line.amount`. */
const listLabel = (list: StmtList | undefined): string =>
  typeof list === "object" ? `arm ${list.arm + 1}` : (list ?? "body");

// Push one option per editable expression in a statement body — precondition /
// requires / let / assignment value (one each), one per emit field, and one per
// bare-call argument — RECURSING into `for` / `if let` / `match` blocks so a
// nested statement's expression is offered too (addressed by `index` + `path`).
// Shared by aggregates (stmtExpr slots) and workflows (wfStmt slots) via the
// slot/value factories.
function pushStatementOptions(
  out: SlotOption[],
  body: readonly Statement[],
  labelPrefix: string,
  mkSlot: (index: number, path: StmtPath, field?: number) => ExprSlot,
  mkValue: (index: number, path: StmtPath, field?: number) => string,
): void {
  const push = (stmt: Statement, index: number, path: StmtPath, prefix: string): void => {
    const add = (label: string, field?: number): void => {
      out.push({ value: mkValue(index, path, field), label: `${prefix}${label}`, slot: mkSlot(index, path, field) });
    };
    if (stmt.$type === "EmitStmt") {
      const emit = stmt as EmitStmt;
      // `$refText` is the event name without triggering a linker deref (the
      // playground parse is unlinked).
      const ev = emit.event?.$refText ?? "event";
      emit.fields.forEach((f, field) => add(`emit ${ev}.${f.name} = ${printExpr(f.value)}`, field));
    } else if (stmt.$type === "AssignOrCallStmt") {
      const a = stmt as AssignOrCallStmt;
      if (a.value) {
        add(stmtLabel(stmt, a.value));
      } else if (a.target?.call) {
        // Bare call (`x.method(args)`) — one slot per argument.
        const name = lvalueName(a.target);
        a.target.args.forEach((arg, field) => add(`${name}(…) arg ${field + 1}: ${printExpr(arg)}`, field));
      }
    } else {
      const expr = stmtSlotExpr(stmt);
      if (expr) add(stmtLabel(stmt, expr));
    }
    // Container forms carry their own nested statement lists.
    for (const { list, items } of nestedStmtLists(stmt)) {
      items.forEach((child, i) =>
        push(child, index, [...path, { index: i, list }], `${prefix}${listLabel(list)} › `),
      );
    }
  };
  body.forEach((stmt, index) => push(stmt, index, [], labelPrefix));
}

function findWorkflow(ast: Model, name: string): Workflow | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Workflow" && (n as Workflow).name === name) return n as Workflow;
  }
  return null;
}

function findRepo(ast: Model, name: string): Repository | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Repository" && (n as Repository).name === name) return n as Repository;
  }
  return null;
}

/** The statement list a statement slot addresses into: an aggregate member
 *  (operation by name, or any `listBodies` key) or a workflow member. */
function slotStatements(ast: Model, slot: ExprSlot): readonly Statement[] {
  if (slot.kind === "stmtExpr") {
    const owner = findOwner(ast, slot.owner);
    if (!owner) return [];
    if (slot.member) return aggregateBodyStatements(owner, slot.member);
    return findOperation(owner, slot.op)?.body ?? [];
  }
  if (slot.kind === "wfStmt") {
    const wf = findWorkflow(ast, slot.owner);
    return wf ? workflowBodyStatements(wf, slot.member) : [];
  }
  return [];
}

export function slotExpr(ast: Model, slot: ExprSlot): Expression | null {
  if (slot.kind === "findFilter") {
    const find = findRepo(ast, slot.owner)?.finds.find((f: FindDecl) => f.name === slot.name);
    return find?.filter ?? null;
  }
  if (slot.kind === "stmtExpr" || slot.kind === "wfStmt") {
    const stmt = statementAt(slotStatements(ast, slot), slotAddr(slot.index, slot.path));
    return stmt ? stmtSlotExpr(stmt, slot.field) : null;
  }
  const owner = findOwner(ast, slot.owner);
  if (!owner) return null;
  const members = membersOf(owner);
  if (slot.kind === "function") {
    const fn = members.find((m): m is FunctionDecl => m.$type === "FunctionDecl" && (m as FunctionDecl).name === slot.name);
    return fn ? ((fn as FunctionDecl).body ?? null) : null;
  }
  if (slot.kind === "derived") {
    const d = members.find((m): m is DerivedProp => m.$type === "DerivedProp" && (m as DerivedProp).name === slot.name);
    return d ? (d as DerivedProp).expr : null;
  }
  const invs = members.filter((m): m is Invariant => m.$type === "Invariant");
  return invs[slot.index] ? (invs[slot.index] as Invariant).expr : null;
}

export interface SlotOption {
  value: string;
  label: string;
  slot: ExprSlot;
}

/** All single-expression slots on an aggregate / value object, for one picker:
 *  functions, derived props, invariants, and operation-body statement
 *  expressions (precondition / requires / let). */
export function exprSlotOptions(node: AstNode): SlotOption[] {
  const owner = (node as { name?: string }).name;
  if (!owner) return [];
  const out: SlotOption[] = [];
  for (const name of listFunctions(node)) {
    out.push({ value: `fn:${name}`, label: `fn ${name}`, slot: { kind: "function", owner, name } });
  }
  for (const name of listDerived(node)) {
    out.push({ value: `derived:${name}`, label: `derived ${name}`, slot: { kind: "derived", owner, name } });
  }
  listInvariants(node).forEach((preview, index) => {
    out.push({ value: `inv:${index}`, label: `invariant: ${preview}`, slot: { kind: "invariant", owner, index } });
  });
  // Operations keep their bare `stmt:<op>:<index>` option value (and their
  // member-less slot); the lifecycle bodies an operation name cannot address —
  // `create` / `destroy` / `apply:<Event>` — come in keyed by `listBodies`.
  for (const m of membersOf(node)) {
    if (m.$type !== "Operation") continue;
    const op = m as Operation;
    pushStatementOptions(
      out,
      op.body,
      `${op.name}: `,
      (index, path, field) => ({
        kind: "stmtExpr",
        owner,
        op: op.name,
        index,
        ...(path.length > 0 ? { path } : {}),
        ...(field !== undefined ? { field } : {}),
      }),
      (index, path, field) =>
        `stmt:${op.name}:${index}${encodeStmtPath(path)}${field !== undefined ? `:${field}` : ""}`,
    );
  }
  if (node.$type === "Aggregate") {
    for (const body of listBodies(node)) {
      if (body.key.startsWith("op:")) continue; // already enumerated above
      pushStatementOptions(
        out,
        aggregateBodyStatements(node, body.key),
        `${body.label}: `,
        (index, path, field) => ({
          kind: "stmtExpr",
          owner,
          op: "",
          member: body.key,
          index,
          ...(path.length > 0 ? { path } : {}),
          ...(field !== undefined ? { field } : {}),
        }),
        (index, path, field) =>
          `stmt@${body.key}:${index}${encodeStmtPath(path)}${field !== undefined ? `:${field}` : ""}`,
      );
    }
  }
  return out;
}

/** Editable statement expressions across EVERY statement-bearing member of a
 *  workflow — the primary + named `create`s, `handle`s, `on` reactors and
 *  `apply` folds — precondition / requires / let / return / assignment value /
 *  emit field values.  The primary create's slots keep their bare `wf:<index>`
 *  option value (and member-less slot) so existing pickers are unaffected. */
export function workflowSlotOptions(node: AstNode): SlotOption[] {
  if (node.$type !== "Workflow") return [];
  const wf = node as Workflow;
  const out: SlotOption[] = [];
  const primary = workflowBodyStatements(wf);
  for (const body of listBodies(wf)) {
    const statements = workflowBodyStatements(wf, body.key);
    const isPrimary = statements === primary;
    pushStatementOptions(
      out,
      statements,
      isPrimary ? "" : `${body.label}: `,
      (index, path, field) => ({
        kind: "wfStmt",
        owner: wf.name,
        ...(isPrimary ? {} : { member: body.key }),
        index,
        ...(path.length > 0 ? { path } : {}),
        ...(field !== undefined ? { field } : {}),
      }),
      (index, path, field) => {
        const head = isPrimary ? "wf" : `wf@${body.key}`;
        return `${head}:${index}${encodeStmtPath(path)}${field !== undefined ? `:${field}` : ""}`;
      },
    );
  }
  return out;
}

/** Expression slots on a repository: each `find` decl's `where` filter. */
export function repoSlotOptions(node: AstNode): SlotOption[] {
  if (node.$type !== "Repository") return [];
  const repo = node as Repository;
  return repo.finds
    .filter((f) => f.filter)
    .map((f) => ({
      value: `find:${f.name}`,
      label: `find ${f.name} where: ${printExpr(f.filter!)}`,
      slot: { kind: "findFilter", owner: repo.name, name: f.name },
    }));
}

export function editExprSlot(source: string, slot: ExprSlot, text: string): string | null {
  const cst = slotExpr(parseDdd(source).ast, slot)?.$cstNode;
  if (!cst) return null;
  const next = applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: text.trim() }]);
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}

function findAgg(ast: Model, name: string | undefined): Aggregate | null {
  if (!name) return null;
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate" && (n as Aggregate).name === name) return n as Aggregate;
  }
  return null;
}

// Build the IR name-resolution environment for a slot's expression, mirroring
// how `lower.ts` sets up each construct (aggregate/VO members, view filters on
// the source aggregate, find filters on the repo's aggregate + param locals).
// The IR's own builders (`newEnv`/`inAggregate`/`withLocal`) and rules
// (`inScopeNames`) are reused so scope knowledge stays in one place.
function withParamsAndLets(env: Env, params: string[], lets: string[]): Env {
  // Only the names matter for enumeration; skip `lowerType` (it would deref
  // `X id` targets, which the main-thread parse can't link).
  let next = env;
  for (const name of params) next = withLocal(next, name, "param", { kind: "primitive", name: "string" });
  for (const name of lets) next = withLocal(next, name, "let", { kind: "primitive", name: "string" });
  return next;
}

const letsBefore = (body: readonly Statement[], index: number): string[] =>
  body.slice(0, index).filter((s) => s.$type === "LetStmt").map((s) => (s as { name: string }).name);

const sameList = (a: StmtList | undefined, b: StmtList | undefined): boolean =>
  typeof a === "object" || typeof b === "object"
    ? typeof a === "object" && typeof b === "object" && a.arm === b.arm
    : (a ?? "body") === (b ?? "body");

/** Names bound BEFORE the addressed statement, walking the descent path: the
 *  `let`s of each list the path passes through, plus each container's own
 *  binder (`for x in …`, `if let x = …`, a match arm's binding) — all of which
 *  are in scope inside the block the path descends into. */
function localsAlongPath(
  statements: readonly Statement[],
  index: number,
  path: StmtPath = [],
): string[] {
  const out: string[] = [];
  let list: readonly Statement[] = statements;
  let cursor = index;
  for (let depth = 0; ; depth++) {
    out.push(...letsBefore(list, cursor));
    const stmt = list[cursor];
    const step = path[depth];
    if (!stmt || !step) break;
    if (stmt.$type === "ForStmt") out.push((stmt as ForStmt).var);
    else if (stmt.$type === "IfLetStmt" && !sameList(step.list, "else")) out.push((stmt as IfLetStmt).var);
    else if (stmt.$type === "MatchStmt" && typeof step.list === "object") {
      const binding = (stmt as MatchStmt).varArms[step.list.arm]?.binding;
      if (binding) out.push(binding);
    }
    const sub = nestedStmtLists(stmt).find((n) => sameList(n.list, step.list));
    if (!sub) break;
    list = sub.items;
    cursor = step.index;
  }
  return out;
}

function slotEnv(ast: Model, slot: ExprSlot): Env | null {
  // Workflows orchestrate across aggregates — no `this`; bare names resolve to
  // params / earlier lets / enums only.
  if (slot.kind === "wfStmt") {
    const wf = findWorkflow(ast, slot.owner);
    if (!wf) return null;
    const ctx = AstUtils.getContainerOfType(wf, isBoundedContext);
    const base: Env = ctx ? newEnv(ctx) : { ctx: undefined, locals: new Map() };
    const body = workflowBodyStatements(wf, slot.member);
    return withParamsAndLets(
      base,
      workflowBodyParamNames(wf, slot.member),
      localsAlongPath(body, slot.index, slot.path),
    );
  }

  let owner: AstNode | null = null;
  let params: Parameter[] = [];
  let paramNames: string[] | null = null;
  let lets: string[] = [];
  let ctxNode: AstNode | null = null;

  if (slot.kind === "findFilter") {
    const repo = findRepo(ast, slot.owner);
    owner = findAgg(ast, repo?.aggregate?.$refText);
    params = repo?.finds.find((f) => f.name === slot.name)?.params ?? [];
    ctxNode = repo;
  } else {
    owner = findOwner(ast, slot.owner);
    ctxNode = owner;
    if (slot.kind === "function") {
      const fn = owner ? membersOf(owner).find((m): m is FunctionDecl => m.$type === "FunctionDecl" && (m as FunctionDecl).name === slot.name) : undefined;
      params = (fn as FunctionDecl | undefined)?.params ?? [];
    } else if (slot.kind === "stmtExpr") {
      // A member key reaches the create / destroy / apply bodies an operation
      // name can't; without one the slot addresses the operation, as before.
      const body = owner && slot.member ? aggregateBodyStatements(owner, slot.member) : null;
      if (body) {
        paramNames = owner ? aggregateBodyParamNames(owner, slot.member as BodyKey) : [];
        lets = localsAlongPath(body, slot.index, slot.path);
      } else {
        const op = findOperation(owner, slot.op);
        params = op?.params ?? [];
        // `let`s declared earlier in the body are in scope for this statement.
        lets = op ? localsAlongPath(op.body, slot.index, slot.path) : [];
      }
    }
  }
  if (!owner) return null;

  const ctx = ctxNode ? AstUtils.getContainerOfType(ctxNode, isBoundedContext) : undefined;
  const base: Env = ctx ? newEnv(ctx as BoundedContext) : { ctx: undefined, locals: new Map() };
  const owned = owner.$type === "ValueObject" ? inValueObject(base, owner as ValueObject) : inAggregate(base, owner as Aggregate);
  return withParamsAndLets(owned, paramNames ?? params.map((p) => p.name), lets);
}

/** In-scope bare names for a slot's expression — drives the editor's name
 *  suggestions. Member-access chains (`a.b`) are out of scope for now. */
export function slotCandidates(ast: Model, slot: ExprSlot): string[] {
  const env = slotEnv(ast, slot);
  return env ? inScopeNames(env).map((c) => c.name) : [];
}

// ---------------------------------------------------------------------------
// Type-directed member-name completion.
//
// Canonical structural path scheme — identical to the one ExpressionEditor.tsx
// threads while rendering, so a member node at path P reads the candidates
// stored here under P.  Each child appends a segment to its parent's path:
//   binary  → left "L",  right "R"
//   unary   → operand "o"
//   paren   → inner "i"
//   member  → receiver "r",  args "a{i}"
//   call    → callee "c",    args "a{i}"
//   lambda  → body "b"
//   builder → entries "f{i}"
//   object  → fields  "f{i}"
// Leaves (names, literals, ternary, match, block-body lambdas) have no
// children — they mirror the editor's `raw`/`lit` leaves.
//
// Member resolution needs resolved cross-references, so this runs against a
// freshly *linked* document (async).  `envForNode` builds the correct env at
// each receiver — including binding an enclosing lambda's param to the
// collection element type — so completion works inside `xs.all(x => x.…)`.
// ---------------------------------------------------------------------------

/** Type-directed hints for an expression, keyed by canonical structural path:
 *  `members` — member-name candidates at each member node; `argLabels` — the
 *  callee's parameter names at each call / member-call node (for labelling
 *  positional argument slots). */
export interface ExprHints {
  members: Map<string, string[]>;
  argLabels: Map<string, string[]>;
}

function collectHints(node: Expression, path: string, h: ExprHints): void {
  switch (node.$type) {
    case "PostfixChain":
      collectPostfixHints(node as PostfixChain, path, h);
      break;
    case "BinaryChain":
      collectBinaryChainHints(node as BinaryChain, path, h);
      break;
    case "UnaryExpr":
      collectHints((node as UnaryExpr).operand, `${path}o`, h);
      break;
    case "ParenExpr":
      collectHints((node as ParenExpr).inner, `${path}i`, h);
      break;
    case "Lambda": {
      const l = node as Lambda;
      if (l.body) collectHints(l.body, `${path}b`, h);
      break;
    }
    case "TernaryExpr": {
      const t = node as TernaryExpr;
      collectHints(t.cond, `${path}?c`, h);
      collectHints(t.thenExpr, `${path}?t`, h);
      collectHints(t.elseExpr, `${path}?e`, h);
      break;
    }
    case "MatchExpr": {
      const m = node as MatchExpr;
      m.arms.forEach((a, i) => {
        collectHints(a.cond, `${path}m${i}c`, h);
        collectHints(a.value, `${path}m${i}v`, h);
      });
      if (m.elseExpr) collectHints(m.elseExpr, `${path}me`, h);
      break;
    }
    case "BuilderCall":
      (node as BuilderCall).entries.forEach((e, i) => collectHints(e.value, `${path}f${i}`, h));
      break;
    case "ObjectLit":
      (node as ObjectLit).fields.forEach((f, i) => collectHints(f.value, `${path}f${i}`, h));
      break;
    // Other forms are opaque leaves (names, literals, …).
  }
}

/** Left-fold a BinaryChain into the path scheme the editor uses
 *  (`L`/`R` per fold step). Mirrors `seedBinaryChain` so paths align. */
function collectBinaryChainHints(node: BinaryChain, path: string, h: ExprHints): void {
  // The structure is left-folded: outermost binary node owns the
  // last operator and rest[len-1] as its R; its L is the next-deeper
  // binary node owning ops[len-2] / rest[len-2]; …; the innermost
  // binary node has the head as its L.
  // Walk from outermost inward, mirroring `seedBinaryChain`.
  const n = node.ops.length;
  if (n === 0) {
    collectHints(node.head, path, h);
    return;
  }
  // Outermost: path with last rest as R.
  collectHints(node.rest[n - 1]!, `${path}R`, h);
  // Walk left-fold steps from len-2 down to 0; each consumes one `L`.
  let lhsPath = `${path}L`;
  for (let i = n - 2; i >= 0; i--) {
    collectHints(node.rest[i]!, `${lhsPath}R`, h);
    lhsPath = `${lhsPath}L`;
  }
  collectHints(node.head, lhsPath, h);
}

/** Walk a PostfixChain's suffixes producing the same path scheme the
 *  editor's nested `member` / `call` view does (mirrors
 *  `seedPostfixChain`). */
function collectPostfixHints(node: PostfixChain, path: string, h: ExprHints): void {
  // seedPostfixChain wraps each suffix outward — the LAST suffix is the
  // outermost node and the head sits at the innermost `r`/`c`-receiver.
  // Walk outermost-first: emit args/labels for the outermost wrapper,
  // descend into the receiver path.
  const suffixes = node.suffixes;
  if (suffixes.length === 0) {
    collectHints(node.head, path, h);
    return;
  }
  // Build the receiver-type chain ahead so we can answer "members at
  // this member node" for each step.  recvTypes[i] = type seen at
  // suffix i's receiver (i.e. before applying suffix i).
  const env = envForNode(node.head);
  let curType = typeOf(node.head, env);
  const recvTypes: Array<typeof curType> = [];
  for (const s of suffixes) {
    recvTypes.push(curType);
    curType = typeAfterSuffix(curType, s, env);
  }
  // Emit hints from outermost suffix inward.  At each step the editor
  // path appends `r` (member.receiver) or `c` (call.callee) to descend.
  let curPath = path;
  for (let i = suffixes.length - 1; i >= 0; i--) {
    const s = suffixes[i]!;
    const recvT = recvTypes[i]!;
    if (s.$type === "MemberSuffix") {
      const ms = s as MemberSuffix;
      h.members.set(curPath, membersOfType(recvT).map((m) => m.name));
      if (ms.call) setSuffixArgLabels(node, i, curPath, h);
      ms.args.forEach((a, j) => collectHints(a.value, `${curPath}a${j}`, h));
      curPath = `${curPath}r`;
    } else {
      // CallSuffix — only meaningful when this is the first suffix and
      // the chain head is a NameRef.  We still walk its args.
      setSuffixArgLabels(node, i, curPath, h);
      (s as { args: { value: Expression }[] }).args.forEach((a, j) =>
        collectHints(a.value, `${curPath}a${j}`, h),
      );
      curPath = `${curPath}c`;
    }
  }
  collectHints(node.head, curPath, h);
}

function setSuffixArgLabels(chain: PostfixChain, suffixIdx: number, path: string, h: ExprHints): void {
  const sig = calleeSignature({ chain, suffixIdx });
  if (sig) h.argLabels.set(path, sig.params.map((p) => p.name));
}

// Size-1 cache of the linked model by source text — switching between slots of
// the same construct reuses one linked build; a commit changes the source and
// rebuilds.
//
// A *rejected* build must not stay cached: the entry would be replayed for
// every later slot on the same (unchanged) source, so one transient failure
// would keep hints broken until the user edits.  Evict on rejection and
// degrade to "no hints" instead.
let linkedCache: { source: string; model: Promise<Model | null> } | null = null;
function linkedModelFor(source: string): Promise<Model | null> {
  if (linkedCache?.source !== source) {
    const entry: { source: string; model: Promise<Model | null> } = {
      source,
      model: buildLinkedModel(source).catch((e: unknown) => {
        if (linkedCache === entry) linkedCache = null;
        // eslint-disable-next-line no-console
        console.error("linked model build failed:", e);
        return null;
      }),
    };
    linkedCache = entry;
  }
  return linkedCache.model;
}

/** Test seam — drop the size-1 linked-model cache. */
export function clearLinkedModelCache(): void {
  linkedCache = null;
}

/** Type-directed hints (member candidates + call arg labels) for a slot's
 *  expression. Async — builds a linked document so types/refs resolve. */
export async function exprHints(source: string, slot: ExprSlot): Promise<ExprHints> {
  const h: ExprHints = { members: new Map(), argLabels: new Map() };
  const model = await linkedModelFor(source);
  if (!model) return h;
  const expr = slotExpr(model, slot);
  if (expr) collectHints(expr, "", h);
  return h;
}

/** Per-member-node member-name candidates (the `members` half of `exprHints`). */
export async function memberCandidates(source: string, slot: ExprSlot): Promise<Map<string, string[]>> {
  return (await exprHints(source, slot)).members;
}

// ---------------------------------------------------------------------------
// Match-arm enum-case picker (option A).
//
// Predicate-style `match` arms have no scrutinee — each cond is a general
// expression. The common shape is `<expr> == EnumCase` / `<expr> != EnumCase`,
// for which we can fill the editor's leaf at the non-enum-typed side with the
// enum's cases. Anything else (nested `&&`, set-membership, …) falls through
// to free text.
//
// Paths mirror `collectHints` exactly so the editor's `ctx.get(path)` lookup
// hits the right leaf. A cond wrapped in parens unwraps via `i`, then the
// single-op chain's left is at `L`, right at `R`.
// ---------------------------------------------------------------------------

function asEnumCases(t: ReturnType<typeof typeOf>): readonly string[] | null {
  if (t.kind !== "enum") return null;
  return t.ref.values.map((v) => v.name);
}

// Peel ParenExpr wrappers off a match-arm cond, tracking the path the editor
// uses to reach each layer. Returns the unwrapped node and its path.
function unwrapParens(expr: Expression, path: string): { node: Expression; path: string } {
  let cur = expr;
  let p = path;
  while (cur.$type === "ParenExpr") {
    cur = (cur as ParenExpr).inner;
    p = `${p}i`;
  }
  return { node: cur, path: p };
}

function collectEnumPicker(node: Expression | undefined, path: string, out: Map<string, readonly string[]>): void {
  if (!node) return;
  switch (node.$type) {
    case "MatchExpr": {
      const m = node as MatchExpr;
      m.arms.forEach((a, i) => {
        if (a.cond) considerArmCond(a.cond, `${path}m${i}c`, out);
        // Arm values can also contain nested matches.
        if (a.value) collectEnumPicker(a.value, `${path}m${i}v`, out);
      });
      if (m.elseExpr) collectEnumPicker(m.elseExpr, `${path}me`, out);
      return;
    }
    case "BinaryChain": {
      const b = node as BinaryChain;
      const n = b.ops.length;
      if (n === 0) { collectEnumPicker(b.head, path, out); return; }
      // Walk the left-fold the same way collectBinaryChainHints does so we
      // recurse into nested matches under arbitrary operands.
      collectEnumPicker(b.rest[n - 1]!, `${path}R`, out);
      let lhsPath = `${path}L`;
      for (let i = n - 2; i >= 0; i--) {
        collectEnumPicker(b.rest[i]!, `${lhsPath}R`, out);
        lhsPath = `${lhsPath}L`;
      }
      collectEnumPicker(b.head, lhsPath, out);
      return;
    }
    case "UnaryExpr":
      collectEnumPicker((node as UnaryExpr).operand, `${path}o`, out);
      return;
    case "ParenExpr":
      collectEnumPicker((node as ParenExpr).inner, `${path}i`, out);
      return;
    case "TernaryExpr": {
      const t = node as TernaryExpr;
      collectEnumPicker(t.cond, `${path}?c`, out);
      collectEnumPicker(t.thenExpr, `${path}?t`, out);
      collectEnumPicker(t.elseExpr, `${path}?e`, out);
      return;
    }
    case "Lambda": {
      const l = node as Lambda;
      if (l.body) collectEnumPicker(l.body, `${path}b`, out);
      return;
    }
    case "BuilderCall":
      (node as BuilderCall).entries.forEach((e, i) => collectEnumPicker(e.value, `${path}f${i}`, out));
      return;
    case "ObjectLit":
      (node as ObjectLit).fields.forEach((f, i) => collectEnumPicker(f.value, `${path}f${i}`, out));
      return;
    // PostfixChain etc. don't carry nested matches under positions the
    // editor exposes as picker-able leaves — drop through.
  }
}

// If a match-arm cond is `<lhs> == <rhs>` (or `!=`), type each side; the
// non-enum operand's leaf gets the enum's cases. The cond's path is the
// editor's match-arm cond path; paren wrappers add `i` segments.
function considerArmCond(cond: Expression, condPath: string, out: Map<string, readonly string[]>): void {
  // Recurse into the arm's value-side and any nested matches inside the cond
  // first so we don't miss a `match { foo => match { … } }`.
  const { node, path } = unwrapParens(cond, condPath);
  if (node.$type !== "BinaryChain") return;
  const b = node as BinaryChain;
  if (b.ops.length !== 1) return;
  const op = b.ops[0]!;
  if (op !== "==" && op !== "!=") return;
  const env = envForNode(b);
  const lhsCases = asEnumCases(typeOf(b.head, env));
  const rhsCases = asEnumCases(typeOf(b.rest[0]!, env));
  // The OTHER operand gets the picker; if both type as enum (the usual
  // `status == Confirmed` shape, where both reference the enum), each
  // side gets the cases of the enum the other resolved to.
  if (rhsCases) out.set(`${path}L`, rhsCases);
  if (lhsCases) out.set(`${path}R`, lhsCases);
}

/** Per-leaf enum-case candidates for a slot's expression — keyed by the
 *  editor's canonical structural path. Covers the top-level `lhs == EnumCase`
 *  / `lhs != EnumCase` shape of `match` arm conds; nested conjunctions and
 *  set-membership fall through to free text. Async — builds a linked
 *  document so types/refs resolve. */
export async function enumPickerCandidates(source: string, slot: ExprSlot): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  const model = await linkedModelFor(source);
  if (!model) return out;
  const expr = slotExpr(model, slot);
  if (expr) collectEnumPicker(expr, "", out);
  return out;
}
