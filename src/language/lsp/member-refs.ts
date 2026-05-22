// ---------------------------------------------------------------------------
// Shared member-access resolution for References and Rename.
//
// `MemberAccess.member` and a bare `NameRef` to a `this`-member are plain
// string tokens, not Langium cross-references, so the index-driven default
// References/Rename providers can't see them.  This module computes, for a
// given member declaration, every usage-site CST token across a document by
// reusing the same `typeOf` / `stepIntoNode` resolution the definition
// provider uses — never textual matching.
// ---------------------------------------------------------------------------

import {
  AstUtils,
  GrammarUtils,
  type AstNode,
  type CstNode,
  type LangiumDocument,
} from "langium";
import {
  isAggregate,
  isEntityPart,
  isFunctionDecl,
  isLambda,
  isLetStmt,
  isLValue,
  isMemberAccess,
  isNameRef,
  isOperation,
  isValueObject,
  isWorkflow,
  type Aggregate,
  type EntityPart,
  type LValue,
  type MemberAccess,
  type NameRef,
  type ValueObject,
} from "../generated/ast.js";
import { envForNode, iterateEntityMembers, stepInto, stepIntoNode, typeOf, type DddType } from "../type-system.js";

type EntityLike = Aggregate | EntityPart | ValueObject;

function isEntityLike(n: AstNode | undefined): n is EntityLike {
  return !!n && (isAggregate(n) || isEntityPart(n) || isValueObject(n));
}

/** Member declarations addressed through member-access / bare this-refs —
 *  the kinds whose usages live in plain string tokens, not cross-references. */
export function isRenameableMember(node: AstNode): boolean {
  if (!isEntityLike(node.$container)) return false;
  const t = node.$type;
  return t === "Property" || t === "Containment" || t === "DerivedProp" || t === "FunctionDecl";
}

/** The CST node of the `.member` identifier token of a member access. */
export function memberNameCst(ma: MemberAccess): CstNode | undefined {
  return GrammarUtils.findNodeForProperty(ma.$cstNode, "member");
}

/** The CST node of a `NameRef`'s identifier token. */
export function nameRefCst(nr: NameRef): CstNode | undefined {
  return GrammarUtils.findNodeForProperty(nr.$cstNode, "name");
}

/** If `cstNode` sits on a member-access token, resolve the member's
 *  declaration via the receiver's type. */
export function memberDeclAt(cstNode: CstNode): AstNode | undefined {
  const ast = cstNode.astNode;
  if (isMemberAccess(ast)) {
    const env = envForNode(ast);
    return stepIntoNode(typeOf(ast.receiver, env), ast.member);
  }
  if (isNameRef(ast)) {
    return nameRefDecl(ast);
  }
  return undefined;
}

/** Resolve a bare `NameRef` to the member declaration it names, if any. Uses
 *  the same `envForNode` the type system uses, so it sees members reachable in
 *  every expression position — aggregate/VO bodies, and the source aggregate of
 *  view filters/binds and repository find filters (where the aggregate comes
 *  through a cross-reference, not containment) — and a closer param / let /
 *  lambda binding correctly shadows the member (env precedence). */
function nameRefDecl(nr: NameRef): AstNode | undefined {
  const name = nr.name;
  if (typeof name !== "string") return undefined;
  const sym = envForNode(nr).resolve(name);
  return sym && isRenameableMember(sym.origin) ? sym.origin : undefined;
}

function nearestEntity(node: AstNode): EntityLike | undefined {
  let n: AstNode | undefined = node.$container;
  while (n) {
    if (isEntityLike(n)) return n;
    n = n.$container;
  }
  return undefined;
}

/** Conservative: any enclosing lambda param, function/operation/workflow
 *  parameter, or `let` binding with the same name shadows the member. */
function localShadows(node: AstNode, name: string): boolean {
  let n: AstNode | undefined = node.$container;
  while (n && !isEntityLike(n)) {
    if (isLambda(n) && n.param === name) return true;
    if ((isOperation(n) || isFunctionDecl(n) || isWorkflow(n)) && n.params.some((p) => p.name === name)) {
      return true;
    }
    const stmts = (n as { stmts?: AstNode[] }).stmts;
    if (Array.isArray(stmts) && stmts.some((s) => isLetStmt(s) && s.name === name)) return true;
    n = n.$container;
  }
  return false;
}

/** A bare `this`-member assignment target rooted at the enclosing entity:
 *  `status := …`, `lines += …`, `a.b := …`. Heads are always member names
 *  (the grammar's LValueIdent has no `this` prefix). Walks head + tail through
 *  the type system, collecting the segment tokens that resolve to `target`. */
function collectLValueUsages(lv: LValue, target: AstNode, out: CstNode[]): void {
  const owner = nearestEntity(lv);
  if (!owner) return;
  const head = lv.head;
  if (localShadows(lv, head)) return; // head is a local binding, not a member
  const info = iterateEntityMembers(owner).find((m) => m.name === head);
  if (!info) return;
  if (info.node === target) pushCst(memberNameCstOf(lv, "head"), out);
  let cur: DddType = info.type;
  const tailCsts = GrammarUtils.findNodesForProperty(lv.$cstNode, "tail");
  lv.tail.forEach((seg, i) => {
    if (stepIntoNode(cur, seg) === target) pushCst(tailCsts[i], out);
    cur = stepInto(cur, seg);
  });
}

function memberNameCstOf(lv: LValue, prop: "head"): CstNode | undefined {
  return GrammarUtils.findNodeForProperty(lv.$cstNode, prop);
}

function pushCst(cst: CstNode | undefined, out: CstNode[]): void {
  if (cst) out.push(cst);
}

/** Every usage-site token in `doc` whose member resolves to `target`. */
export function collectMemberUsages(doc: LangiumDocument, target: AstNode): CstNode[] {
  const root = doc.parseResult?.value;
  if (!root) return [];
  const out: CstNode[] = [];
  for (const node of AstUtils.streamAllContents(root)) {
    if (isMemberAccess(node)) {
      const decl = stepIntoNode(typeOf(node.receiver, envForNode(node)), node.member);
      if (decl === target) {
        const cst = memberNameCst(node);
        if (cst) out.push(cst);
      }
    } else if (isNameRef(node)) {
      if (nameRefDecl(node) === target) {
        const cst = nameRefCst(node);
        if (cst) out.push(cst);
      }
    } else if (isLValue(node)) {
      collectLValueUsages(node, target, out);
    }
  }
  return out;
}
