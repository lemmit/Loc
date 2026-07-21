import { AstUtils, type AstNode } from "langium";
import {
  isBoundedContext,
  isWorkflowCreateDecl,
  type Aggregate,
  type AssignOrCallStmt,
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
  type WorkflowCreateDecl,
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

/** A2-S5f: a workflow body is members-only; its sequential statements + params
 *  live in the primary `create(...)` starter (unnamed, command-triggered).  The
 *  statement editor / slot indices operate on that create body. */
function primaryWfCreate(wf: Workflow): WorkflowCreateDecl | undefined {
  const creates = wf.members.filter(isWorkflowCreateDecl);
  return creates.find((c) => !c.name) ?? creates[0];
}
function wfStatements(wf: Workflow): Statement[] {
  return primaryWfCreate(wf)?.body ?? [];
}

function findRepo(ast: Model, name: string): Repository | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Repository" && (n as Repository).name === name) return n as Repository;
  }
  return null;
}

export function slotExpr(ast: Model, slot: ExprSlot): Expression | null {
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
    const wf = findWorkflow(ast, slot.owner);
    const stmt = wf ? wfStatements(wf)[slot.index] : undefined;
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
    wfStatements(wf),
    "",
    (index, field) => ({ kind: "wfStmt", owner: wf.name, index, ...(field !== undefined ? { field } : {}) }),
    (index, field) => (field !== undefined ? `wf:${index}:${field}` : `wf:${index}`),
  );
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
  // `X id` targets, which the main-thread parse can't link).
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
    const create = primaryWfCreate(wf);
    return withParamsAndLets(base, create?.params ?? [], letsBefore(create?.body ?? [], slot.index));
  }

  let owner: AstNode | null = null;
  let params: Parameter[] = [];
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
