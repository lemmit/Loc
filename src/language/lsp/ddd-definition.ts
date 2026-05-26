import { AstUtils, type CstNode, type MaybePromise } from "langium";
import { DefaultDefinitionProvider } from "langium/lsp";
import { type DefinitionParams, LocationLink } from "vscode-languageserver";
import { isMemberSuffix, isPostfixChain } from "../generated/ast.js";
import { envForNode, stepIntoNode, typeAfterSuffix, typeOf } from "../type-system.js";

// ---------------------------------------------------------------------------
// DddDefinitionProvider — extends the default with member-access
// resolution.  Langium's default handles every grammar `[X:ID]`
// cross-reference, so for `Order id` / `contains lines: OrderLine` /
// named-type / repository-for / emit / system module + targets we just
// delegate.  But `MemberAccess.member` is a plain string token — the
// default has no way to resolve `order.lines` to the `Containment`
// declaration on the receiver's type.  We bridge that gap by computing
// the receiver type via `typeOf` + `envForNode`, then looking up the
// matching member's AST node via `stepIntoNode`.
// ---------------------------------------------------------------------------

export class DddDefinitionProvider extends DefaultDefinitionProvider {
  protected override collectLocationLinks(
    sourceCstNode: CstNode,
    params: DefinitionParams,
  ): MaybePromise<LocationLink[] | undefined> {
    // 1. If the default can resolve via cross-reference, prefer that.
    const fromDefault = super.collectLocationLinks(sourceCstNode, params);
    if (fromDefault) return fromDefault;

    // 2. Try the member-access fallback — only for tokens whose AST
    //    parent is a `MemberAccess` and whose text matches `.member`.
    const link = this.memberAccessLink(sourceCstNode);
    return link ? [link] : undefined;
  }

  private memberAccessLink(sourceCstNode: CstNode): LocationLink | undefined {
    const ast = sourceCstNode.astNode;
    if (!isMemberSuffix(ast)) return undefined;
    // The source CST might cover the whole MemberSuffix node.  The
    // token under the cursor is what `findDeclarationNodeAtOffset`
    // resolved to (typically the `member` ID token).
    if (sourceCstNode.text !== ast.member) return undefined;

    const chain = ast.$container;
    if (!isPostfixChain(chain)) return undefined;
    const idx = chain.suffixes.indexOf(ast);
    if (idx < 0) return undefined;

    const env = envForNode(ast);
    let receiverType = typeOf(chain.head, env);
    for (let i = 0; i < idx; i++) {
      receiverType = typeAfterSuffix(receiverType, chain.suffixes[i]!, env);
    }
    const targetNode = stepIntoNode(receiverType, ast.member);
    if (!targetNode) return undefined;

    const targetCst = targetNode.$cstNode;
    if (!targetCst) return undefined;

    // Use the *name* node's range as the selection (mirrors Langium's
    // default, which highlights just the identifier on jump rather than
    // the whole declaration).
    const nameNode = this.nameProvider.getNameNode(targetNode) ?? targetCst;

    const targetDocument = AstUtils.getDocument(targetNode);
    return LocationLink.create(
      targetDocument.textDocument.uri,
      targetCst.range,
      nameNode.range,
      sourceCstNode.range,
    );
  }
}
