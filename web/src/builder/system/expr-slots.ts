import { AstUtils, type AstNode } from "langium";
import type {
  Aggregate,
  BindEntry,
  DerivedProp,
  Expression,
  FunctionDecl,
  Invariant,
  Model,
  ValueObject,
  View,
} from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";
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
  | { kind: "viewBind"; owner: string; name: string };

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

export function slotExpr(ast: Model, slot: ExprSlot): Expression | null {
  if (slot.kind === "viewFilter") {
    return findView(ast, slot.owner)?.filter ?? null;
  }
  if (slot.kind === "viewBind") {
    const bind = findView(ast, slot.owner)?.binds.find((b: BindEntry) => b.name === slot.name);
    return bind ? bind.expr : null;
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

export function editExprSlot(source: string, slot: ExprSlot, text: string): string | null {
  const cst = slotExpr(parseDdd(source).ast, slot)?.$cstNode;
  if (!cst) return null;
  const next = applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: text.trim() }]);
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}
