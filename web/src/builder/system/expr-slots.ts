import { AstUtils, type AstNode } from "langium";
import {
  isBoundedContext,
  type Aggregate,
  type AssignOrCallStmt,
  type BindEntry,
  type BoundedContext,
  type DerivedProp,
  type EmitStmt,
  type Expression,
  type FindDecl,
  type FunctionDecl,
  type Invariant,
  type Model,
  type Operation,
  type Parameter,
  type Repository,
  type BinaryExpr,
  type CallExpr,
  type Lambda,
  type MatchExpr,
  type MemberAccess,
  type NewExpr,
  type ObjectLit,
  type ParenExpr,
  type Statement,
  type TernaryExpr,
  type UnaryExpr,
  type ValueObject,
  type View,
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
} from "../../../../src/ir/lower-expr.js";
import { calleeSignature, envForNode, membersOfType, typeOf } from "../../../../src/language/type-system.js";
import { applyEdits } from "../edit-engine";
import { buildLinkedModel } from "./linked-doc";
import { parseDdd } from "../parse";
import { listFunctions } from "./body";

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
  | { kind: "viewFilter"; owner: string }
  | { kind: "viewBind"; owner: string; name: string }
  | { kind: "findFilter"; owner: string; name: string }
  | { kind: "stmtExpr"; owner: string; op: string; index: number; field?: number }
  | { kind: "wfStmt"; owner: string; index: number; field?: number };

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
  if (stmt.$type === "AssignOrCallStmt") {
    const a = stmt as AssignOrCallStmt;
    return `${a.target?.$cstNode?.text ?? ""} ${a.op ?? "="} ${printExpr(expr)}`;
  }
  return printExpr(expr);
}

// Push one option per editable expression in a statement body — precondition /
// requires / let / assignment value (one each), one per emit field, and one per
// bare-call argument. Shared by operations (stmtExpr slots) and workflows
// (wfStmt slots) via the slot/value factories.
function pushStatementOptions(
  out: SlotOption[],
  body: readonly Statement[],
  labelPrefix: string,
  mkSlot: (index: number, field?: number) => ExprSlot,
  mkValue: (index: number, field?: number) => string,
): void {
  body.forEach((stmt, index) => {
    if (stmt.$type === "EmitStmt") {
      const emit = stmt as EmitStmt;
      // `$refText` is the event name without triggering a linker deref (the
      // playground parse is unlinked).
      const ev = emit.event?.$refText ?? "event";
      emit.fields.forEach((f, field) => {
        out.push({ value: mkValue(index, field), label: `${labelPrefix}emit ${ev}.${f.name} = ${printExpr(f.value)}`, slot: mkSlot(index, field) });
      });
      return;
    }
    if (stmt.$type === "AssignOrCallStmt") {
      const a = stmt as AssignOrCallStmt;
      if (a.value) {
        out.push({ value: mkValue(index), label: `${labelPrefix}${stmtLabel(stmt, a.value)}`, slot: mkSlot(index) });
      } else if (a.target?.call) {
        // Bare call (`x.method(args)`) — one slot per argument.
        const name = lvalueName(a.target);
        a.target.args.forEach((arg, field) => {
          out.push({ value: mkValue(index, field), label: `${labelPrefix}${name}(…) arg ${field + 1}: ${printExpr(arg)}`, slot: mkSlot(index, field) });
        });
      }
      return;
    }
    const expr = stmtSlotExpr(stmt);
    if (!expr) return;
    out.push({ value: mkValue(index), label: `${labelPrefix}${stmtLabel(stmt, expr)}`, slot: mkSlot(index) });
  });
}

function findWorkflow(ast: Model, name: string): Workflow | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Workflow" && (n as Workflow).name === name) return n as Workflow;
  }
  return null;
}

function findView(ast: Model, name: string): View | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "View" && (n as View).name === name) return n as View;
  }
  return null;
}

function findRepo(ast: Model, name: string): Repository | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Repository" && (n as Repository).name === name) return n as Repository;
  }
  return null;
}

export function slotExpr(ast: Model, slot: ExprSlot): Expression | null {
  if (slot.kind === "viewFilter") {
    return findView(ast, slot.owner)?.filter ?? null;
  }
  if (slot.kind === "viewBind") {
    const bind = findView(ast, slot.owner)?.binds.find((b: BindEntry) => b.name === slot.name);
    return bind ? bind.expr : null;
  }
  if (slot.kind === "findFilter") {
    const find = findRepo(ast, slot.owner)?.finds.find((f: FindDecl) => f.name === slot.name);
    return find?.filter ?? null;
  }
  if (slot.kind === "stmtExpr") {
    const op = findOperation(findOwner(ast, slot.owner), slot.op);
    const stmt = op?.body[slot.index];
    return stmt ? stmtSlotExpr(stmt, slot.field) : null;
  }
  if (slot.kind === "wfStmt") {
    const stmt = findWorkflow(ast, slot.owner)?.body[slot.index];
    return stmt ? stmtSlotExpr(stmt, slot.field) : null;
  }
  const owner = findOwner(ast, slot.owner);
  if (!owner) return null;
  const members = membersOf(owner);
  if (slot.kind === "function") {
    const fn = members.find((m): m is FunctionDecl => m.$type === "FunctionDecl" && (m as FunctionDecl).name === slot.name);
    return fn ? (fn as FunctionDecl).body : null;
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
  for (const m of membersOf(node)) {
    if (m.$type !== "Operation") continue;
    const op = m as Operation;
    pushStatementOptions(
      out,
      op.body,
      `${op.name}: `,
      (index, field) => ({ kind: "stmtExpr", owner, op: op.name, index, ...(field !== undefined ? { field } : {}) }),
      (index, field) => (field !== undefined ? `stmt:${op.name}:${index}:${field}` : `stmt:${op.name}:${index}`),
    );
  }
  return out;
}

/** Editable statement expressions in a workflow body — precondition / requires /
 *  let / assignment value / emit field values. */
export function workflowSlotOptions(node: AstNode): SlotOption[] {
  if (node.$type !== "Workflow") return [];
  const wf = node as Workflow;
  const out: SlotOption[] = [];
  pushStatementOptions(
    out,
    wf.body,
    "",
    (index, field) => ({ kind: "wfStmt", owner: wf.name, index, ...(field !== undefined ? { field } : {}) }),
    (index, field) => (field !== undefined ? `wf:${index}:${field}` : `wf:${index}`),
  );
  return out;
}

/** Expression slots on a view: the `where` filter (if any) and each bind. */
export function viewSlotOptions(node: AstNode): SlotOption[] {
  if (node.$type !== "View") return [];
  const view = node as View;
  const out: SlotOption[] = [];
  if (view.filter) {
    out.push({ value: "filter", label: `where: ${printExpr(view.filter)}`, slot: { kind: "viewFilter", owner: view.name } });
  }
  for (const b of view.binds) {
    out.push({ value: `bind:${b.name}`, label: `bind ${b.name}`, slot: { kind: "viewBind", owner: view.name, name: b.name } });
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
function withParamsAndLets(env: Env, params: Parameter[], lets: string[]): Env {
  // Only the names matter for enumeration; skip `lowerType` (it would deref
  // `Id<X>` targets, which the main-thread parse can't link).
  let next = env;
  for (const p of params) next = withLocal(next, p.name, "param", { kind: "primitive", name: "string" });
  for (const name of lets) next = withLocal(next, name, "let", { kind: "primitive", name: "string" });
  return next;
}

const letsBefore = (body: readonly Statement[], index: number): string[] =>
  body.slice(0, index).filter((s) => s.$type === "LetStmt").map((s) => (s as { name: string }).name);

function slotEnv(ast: Model, slot: ExprSlot): Env | null {
  // Workflows orchestrate across aggregates — no `this`; bare names resolve to
  // params / earlier lets / enums only.
  if (slot.kind === "wfStmt") {
    const wf = findWorkflow(ast, slot.owner);
    if (!wf) return null;
    const ctx = AstUtils.getContainerOfType(wf, isBoundedContext);
    const base: Env = ctx ? newEnv(ctx) : { ctx: undefined, locals: new Map() };
    return withParamsAndLets(base, wf.params, letsBefore(wf.body, slot.index));
  }

  let owner: AstNode | null = null;
  let params: Parameter[] = [];
  let lets: string[] = [];
  let ctxNode: AstNode | null = null;

  if (slot.kind === "viewFilter" || slot.kind === "viewBind") {
    const view = findView(ast, slot.owner);
    owner = findAgg(ast, view?.source?.$refText);
    ctxNode = view;
  } else if (slot.kind === "findFilter") {
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
      const op = findOperation(owner, slot.op);
      params = op?.params ?? [];
      // `let`s declared earlier in the body are in scope for this statement.
      lets = op ? letsBefore(op.body, slot.index) : [];
    }
  }
  if (!owner) return null;

  const ctx = ctxNode ? AstUtils.getContainerOfType(ctxNode, isBoundedContext) : undefined;
  const base: Env = ctx ? newEnv(ctx as BoundedContext) : { ctx: undefined, locals: new Map() };
  const owned = owner.$type === "ValueObject" ? inValueObject(base, owner as ValueObject) : inAggregate(base, owner as Aggregate);
  return withParamsAndLets(owned, params, lets);
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
//   new/obj → fields "f{i}"
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
    case "MemberAccess": {
      const ma = node as MemberAccess;
      if (ma.receiver) {
        h.members.set(path, membersOfType(typeOf(ma.receiver, envForNode(ma.receiver))).map((m) => m.name));
        collectHints(ma.receiver, `${path}r`, h);
      }
      if (ma.call) setArgLabels(ma, path, h);
      ma.args.forEach((a, i) => collectHints(a.value, `${path}a${i}`, h));
      break;
    }
    case "CallExpr": {
      const c = node as CallExpr;
      setArgLabels(c, path, h);
      collectHints(c.callee, `${path}c`, h);
      c.args.forEach((a, i) => collectHints(a.value, `${path}a${i}`, h));
      break;
    }
    case "BinaryExpr": {
      const b = node as BinaryExpr;
      collectHints(b.left, `${path}L`, h);
      collectHints(b.right, `${path}R`, h);
      break;
    }
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
      collectHints(t.condition, `${path}?c`, h);
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
    case "NewExpr":
      (node as NewExpr).fields.forEach((f, i) => collectHints(f.value, `${path}f${i}`, h));
      break;
    case "ObjectLit":
      (node as ObjectLit).fields.forEach((f, i) => collectHints(f.value, `${path}f${i}`, h));
      break;
    // Other forms are opaque leaves (names, literals, …).
  }
}

function setArgLabels(call: CallExpr | MemberAccess, path: string, h: ExprHints): void {
  const sig = calleeSignature(call);
  if (sig) h.argLabels.set(path, sig.params.map((p) => p.name));
}

// Size-1 cache of the linked model by source text — switching between slots of
// the same construct reuses one linked build; a commit changes the source and
// rebuilds.
let linkedCache: { source: string; model: Promise<Model | null> } | null = null;
function linkedModelFor(source: string): Promise<Model | null> {
  if (linkedCache?.source !== source) linkedCache = { source, model: buildLinkedModel(source) };
  return linkedCache.model;
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
