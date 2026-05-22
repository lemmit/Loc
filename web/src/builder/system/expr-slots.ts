import { AstUtils, type AstNode } from "langium";
import {
  isBoundedContext,
  type Aggregate,
  type BindEntry,
  type BoundedContext,
  type DerivedProp,
  type Expression,
  type FindDecl,
  type FunctionDecl,
  type Invariant,
  type Model,
  type Parameter,
  type Repository,
  type ValueObject,
  type View,
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
import { applyEdits } from "../edit-engine";
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
  | { kind: "findFilter"; owner: string; name: string };

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
 *  functions, derived props, and invariants. */
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
function slotEnv(ast: Model, slot: ExprSlot): Env | null {
  let owner: AstNode | null = null;
  let params: Parameter[] = [];
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
    }
  }
  if (!owner) return null;

  const ctx = ctxNode ? AstUtils.getContainerOfType(ctxNode, isBoundedContext) : undefined;
  const base: Env = ctx ? newEnv(ctx as BoundedContext) : { ctx: undefined, locals: new Map() };
  let env = owner.$type === "ValueObject" ? inValueObject(base, owner as ValueObject) : inAggregate(base, owner as Aggregate);
  // Only the param *names* matter for enumeration; skip `lowerType` (it would
  // deref `Id<X>` targets, which the main-thread parse can't link).
  for (const p of params) env = withLocal(env, p.name, "param", { kind: "primitive", name: "string" });
  return env;
}

/** In-scope bare names for a slot's expression — drives the editor's name
 *  suggestions. Member-access chains (`a.b`) are out of scope for now. */
export function slotCandidates(ast: Model, slot: ExprSlot): string[] {
  const env = slotEnv(ast, slot);
  return env ? inScopeNames(env).map((c) => c.name) : [];
}
