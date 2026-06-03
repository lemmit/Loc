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

import { type AstNode, AstUtils, type CstNode, GrammarUtils, type LangiumDocument } from "langium";
import {
  type Aggregate,
  type EntityPart,
  isAggregate,
  isEntityPart,
  isFunctionDecl,
  isHandleDecl,
  isLambda,
  isLetStmt,
  isLValue,
  isMemberSuffix,
  isNameRef,
  isOnDecl,
  isOperation,
  isPostfixChain,
  isValueObject,
  isWorkflowCreateDecl,
  type LValue,
  type MemberSuffix,
  type NameRef,
  type ValueObject,
} from "../generated/ast.js";
import {
  type DddType,
  envForNode,
  iterateEntityMembers,
  stepInto,
  stepIntoNode,
  typeAfterSuffix,
  typeOf,
} from "../type-system.js";

type EntityLike = Aggregate | EntityPart | ValueObject;

function isEntityLike(n: AstNode | undefined): n is EntityLike {
  return !!n && (isAggregate(n) || isEntityPart(n) || isValueObject(n));
}

/** Member declarations addressed through member-access / bare this-refs —
 *  the kinds whose usages live in plain string tokens, not cross-references.
 *  `Operation` is included: operation call sites (`order.close()`) are
 *  `MemberSuffix` tokens invisible to the cross-reference index, so renaming an
 *  operation must go through the member-usage rewrite path, not the default
 *  index-driven rename (which would leave every call site stale). */
export function isRenameableMember(node: AstNode): boolean {
  if (!isEntityLike(node.$container)) return false;
  const t = node.$type;
  return (
    t === "Property" ||
    t === "Containment" ||
    t === "DerivedProp" ||
    t === "FunctionDecl" ||
    t === "Operation"
  );
}

/** The CST node of the `.member` identifier token of a member access
 *  suffix. */
export function memberNameCst(ms: MemberSuffix): CstNode | undefined {
  return GrammarUtils.findNodeForProperty(ms.$cstNode, "member");
}

/** Walk head + prior suffixes of a PostfixChain to compute the
 *  receiver type at the given MemberSuffix.  Mirrors the same walk
 *  used by the definition / completion / semantic-tokens providers. */
function receiverTypeForSuffix(ms: MemberSuffix): DddType | undefined {
  const chain = ms.$container;
  if (!isPostfixChain(chain)) return undefined;
  const idx = chain.suffixes.indexOf(ms);
  if (idx < 0) return undefined;
  const env = envForNode(ms);
  let t = typeOf(chain.head, env);
  for (let i = 0; i < idx; i++) {
    t = typeAfterSuffix(t, chain.suffixes[i]!, env);
  }
  return t;
}

/** The CST node of a `NameRef`'s identifier token. */
export function nameRefCst(nr: NameRef): CstNode | undefined {
  return GrammarUtils.findNodeForProperty(nr.$cstNode, "name");
}

/** If `cstNode` sits on a member-access token, resolve the member's
 *  declaration via the receiver's type. */
export function memberDeclAt(cstNode: CstNode): AstNode | undefined {
  const ast = cstNode.astNode;
  if (isMemberSuffix(ast)) {
    const recvType = receiverTypeForSuffix(ast);
    if (!recvType) return undefined;
    return stepIntoNode(recvType, ast.member);
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
  // A closer same-named binding (lambda param, operation/function/workflow
  // param, `let`) shadows the member — that reference is not a member usage,
  // so renaming the member must leave it alone.  `envForNode` doesn't always
  // model lambda-param shadowing, so guard explicitly.
  if (localShadows(nr, name)) return undefined;
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
    if ((isOperation(n) || isFunctionDecl(n)) && n.params.some((p) => p.name === name)) {
      return true;
    }
    // A workflow body is members-only (A2-S5f) — params + free statements live
    // inside `create`/`handle` members, so the param/let shadowing checks live
    // on those, not on the workflow itself.
    if (
      (isWorkflowCreateDecl(n) || isHandleDecl(n)) &&
      (n.params.some((p) => p.name === name) || n.body.some((s) => isLetStmt(s) && s.name === name))
    ) {
      return true;
    }
    // Operation bodies are `Statement[]`; a `let` of the same name shadows the
    // member. (FunctionDecl.body is a single Expression — no lets.)
    if (isOperation(n) && n.body.some((s) => isLetStmt(s) && s.name === name)) {
      return true;
    }
    // Inside an `on(e: Event) { … }` reactor, the event binding and the
    // reactor body's own lets shadow.
    if (isOnDecl(n) && (n.param === name || n.body.some((s) => isLetStmt(s) && s.name === name))) {
      return true;
    }
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
    if (isMemberSuffix(node)) {
      const recvType = receiverTypeForSuffix(node);
      if (recvType) {
        const decl = stepIntoNode(recvType, node.member);
        if (decl === target) {
          const cst = memberNameCst(node);
          if (cst) out.push(cst);
        }
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
