import { DefaultDefinitionProvider, type LangiumServices } from "langium/lsp";
import {
  AstUtils,
  type CstNode,
  type MaybePromise,
} from "langium";
import {
  LocationLink,
  type DefinitionParams,
} from "vscode-languageserver";
import { isMemberAccess } from "../generated/ast.js";
import { envForNode, stepIntoNode, typeOf } from "../type-system.js";

// ---------------------------------------------------------------------------
// DddDefinitionProvider — extends the default with member-access
// resolution.  Langium's default handles every grammar `[X:ID]`
// cross-reference, so for `Id<Order>` / `contains lines: OrderLine` /
// named-type / repository-for / emit / system module + targets we just
// delegate.  But `MemberAccess.member` is a plain string token — the
// default has no way to resolve `order.lines` to the `Containment`
// declaration on the receiver's type.  We bridge that gap by computing
// the receiver type via `typeOf` + `envForNode`, then looking up the
// matching member's AST node via `stepIntoNode`.
// ---------------------------------------------------------------------------

export class DddDefinitionProvider extends DefaultDefinitionProvider {
  constructor(services: LangiumServices) {
    super(services);
  }

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
    if (!isMemberAccess(ast)) return undefined;
    // The source CST might cover the whole `MemberAccess` node.  The
    // token under the cursor is what `findDeclarationNodeAtOffset`
    // resolved to (typically the `member` ID token).  We accept either
    // — the fallback only fires when the default returned undefined.
    if (sourceCstNode.text !== ast.member) return undefined;

    const env = envForNode(ast);
    const receiverType = typeOf(ast.receiver, env);
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
