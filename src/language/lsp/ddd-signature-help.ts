import { type AstNode, CstUtils, type LangiumDocument, type MaybePromise } from "langium";
import type { SignatureHelpProvider } from "langium/lsp";
import type {
  SignatureHelp,
  SignatureHelpOptions,
  SignatureHelpParams,
} from "vscode-languageserver";
import {
  type BuilderCall,
  type BuilderEntry,
  type CallArg,
  isBuilderCall,
  isCallSuffix,
  isMemberSuffix,
  isPostfixChain,
  type PostfixChain,
} from "../generated/ast.js";
import { calleeSignature } from "../type-system.js";
import { buildSignature } from "./render-signature.js";

// ---------------------------------------------------------------------------
// DddSignatureHelpProvider — shows the parameter list of the function /
// operation / value-object constructor being called while the cursor is
// inside its argument list (CallExpr / MemberAccess) or its slot list
// (v2 BuilderCall, `Money { amount: ..., currency: ... }`).
// ---------------------------------------------------------------------------

export class DddSignatureHelpProvider implements SignatureHelpProvider {
  get signatureHelpOptions(): SignatureHelpOptions {
    return { triggerCharacters: ["(", "{", ","], retriggerCharacters: [","] };
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
    if ("chain" in call) {
      const sig = calleeSignature(call);
      if (!sig) return undefined;
      const suffix = call.chain.suffixes[call.suffixIdx]!;
      const items = isMemberSuffix(suffix) ? suffix.args : (suffix as { args: CallArg[] }).args;
      return {
        signatures: [buildSignature(sig.name, sig.params, sig.ret, "()")],
        activeSignature: 0,
        activeParameter: activeParam(items, offset),
      };
    }
    // BuilderCall branch.
    const sig = calleeSignature(call);
    if (!sig) return undefined;
    const items = call.entries;
    return {
      signatures: [buildSignature(sig.name, sig.params, sig.ret, "{}")],
      activeSignature: 0,
      activeParameter: activeParam(items, offset),
    };
  }
}

function enclosingCall(
  node: AstNode | undefined,
): BuilderCall | { chain: PostfixChain; suffixIdx: number } | undefined {
  let n: AstNode | undefined = node;
  while (n) {
    if (isBuilderCall(n)) return n;
    // A MemberSuffix with `call: true` or a CallSuffix is the unit of
    // signature help in the postfix world.
    if (isMemberSuffix(n) && n.call) {
      const chain = n.$container;
      if (isPostfixChain(chain)) {
        const idx = chain.suffixes.indexOf(n);
        if (idx >= 0) return { chain, suffixIdx: idx };
      }
    }
    if (isCallSuffix(n)) {
      const chain = n.$container;
      if (isPostfixChain(chain)) {
        const idx = chain.suffixes.indexOf(n);
        if (idx >= 0) return { chain, suffixIdx: idx };
      }
    }
    n = n.$container;
  }
  return undefined;
}

function activeParam(items: ReadonlyArray<CallArg | BuilderEntry>, offset: number): number {
  let active = 0;
  for (const item of items) {
    const end = item.$cstNode?.end;
    if (end !== undefined && offset > end) active++;
    else break;
  }
  return active;
}
