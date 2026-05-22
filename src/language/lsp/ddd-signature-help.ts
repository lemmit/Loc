import { type LangiumServices, type SignatureHelpProvider } from "langium/lsp";
import {
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
  isCallExpr,
  isMemberAccess,
  type CallArg,
  type CallExpr,
  type MemberAccess,
} from "../generated/ast.js";
import { calleeSignature } from "../type-system.js";
import { buildSignature } from "./render-signature.js";

// ---------------------------------------------------------------------------
// DddSignatureHelpProvider — shows the parameter list of the function /
// operation / value-object constructor being called while the cursor is
// inside its argument list.  The callee is resolved through the shared
// `calleeSignature` (same type system the rest of the LSP uses), so the
// signature popup and the Model builder's argument labels agree.
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
    const sig = calleeSignature(call);
    if (!sig) return undefined;
    return {
      signatures: [buildSignature(sig.name, sig.params, sig.ret)],
      activeSignature: 0,
      activeParameter: activeParam(call.args, offset),
    };
  }
}

function enclosingCall(node: AstNode | undefined): CallExpr | MemberAccess | undefined {
  let n: AstNode | undefined = node;
  while (n) {
    if (isCallExpr(n)) return n;
    if (isMemberAccess(n) && n.call) return n;
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
