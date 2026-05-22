import { type LangiumServices, type SignatureHelpProvider } from "langium/lsp";
import {
  AstUtils,
  CstUtils,
  type AstNode,
  type LangiumDocument,
  type MaybePromise,
} from "langium";
import type {
  SignatureHelp,
  SignatureHelpOptions,
  SignatureHelpParams,
} from "vscode-languageserver";
import {
  isAggregate,
  isCallExpr,
  isEntityPart,
  isFunctionDecl,
  isMemberAccess,
  isNameRef,
  isOperation,
  isValueObject,
  type CallArg,
  type Expression,
  type FunctionDecl,
  type Operation,
} from "../generated/ast.js";
import { envForNode, stepIntoNode, typeOf } from "../type-system.js";
import { buildSignature } from "./render-signature.js";

// ---------------------------------------------------------------------------
// DddSignatureHelpProvider — shows the parameter list of the function /
// operation being called while the cursor is inside its argument list.
// The callee is resolved through the same type system the rest of the LSP
// uses: a bare name resolves to a function/operation on the enclosing
// entity; `recv.method(...)` resolves via the receiver's type.
// ---------------------------------------------------------------------------

export class DddSignatureHelpProvider implements SignatureHelpProvider {
  constructor(_services: LangiumServices) {}

  get signatureHelpOptions(): SignatureHelpOptions {
    return { triggerCharacters: ["(", ","], retriggerCharacters: [","] };
  }

  provideSignatureHelp(
    document: LangiumDocument,
    params: SignatureHelpParams,
  ): MaybePromise<SignatureHelp | undefined> {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(params.position);
    const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
    const call = enclosingCall(leaf?.astNode);
    if (!call) return undefined;
    const target = resolveCallee(call);
    if (!target) return undefined;
    const ret = isFunctionDecl(target) ? target.returnType : undefined;
    const signature = buildSignature(target.name, target.params, ret);
    return {
      signatures: [signature],
      activeSignature: 0,
      activeParameter: activeParam(call.args, offset),
    };
  }
}

// A call site is either a bare `name(args)` (CallExpr) or a method call
// `recv.member(args)` (a MemberAccess with `call === true`).
type CallSite = { args: CallArg[]; callee: Expression } | { args: CallArg[]; member: string; receiver: Expression };

function enclosingCall(node: AstNode | undefined): CallSite | undefined {
  let n: AstNode | undefined = node;
  while (n) {
    if (isCallExpr(n)) return { args: n.args, callee: n.callee };
    if (isMemberAccess(n) && n.call) return { args: n.args, member: n.member, receiver: n.receiver };
    n = n.$container;
  }
  return undefined;
}

function resolveCallee(call: CallSite): FunctionDecl | Operation | undefined {
  if ("callee" in call) {
    const callee = call.callee;
    if (!isNameRef(callee)) return undefined;
    const owner = nearestEntity(callee);
    if (!owner) return undefined;
    for (const m of owner.members) {
      if ((isFunctionDecl(m) || isOperation(m)) && m.name === callee.name) return m;
    }
    return undefined;
  }
  const decl = stepIntoNode(typeOf(call.receiver, envForNode(call.receiver)), call.member);
  if (decl && (isFunctionDecl(decl) || isOperation(decl))) return decl;
  return undefined;
}

function nearestEntity(node: AstNode) {
  let n: AstNode | undefined = node.$container;
  while (n) {
    if (isAggregate(n) || isEntityPart(n) || isValueObject(n)) return n;
    n = n.$container;
  }
  return undefined;
}

function activeParam(args: CallArg[], offset: number): number {
  let active = 0;
  for (const arg of args) {
    const end = arg.$cstNode?.end;
    if (end !== undefined && offset > end) active++;
    else break;
  }
  return active;
}
