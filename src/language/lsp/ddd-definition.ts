import { AstUtils, type CstNode, type LangiumDocuments, type MaybePromise } from "langium";
import { DefaultDefinitionProvider, type LangiumServices } from "langium/lsp";
import { type DefinitionParams, LocationLink } from "vscode-languageserver";
import { builtinCapabilities } from "../../macros/prelude.js";
import {
  isCapability,
  isImplementsDecl,
  isMacroCall,
  isMemberSuffix,
  isPostfixChain,
  type Model,
} from "../generated/ast.js";
import { envForNode, stepIntoNode, typeAfterSuffix, typeOf } from "../type-system.js";

/** The capability name a CST token names — the `with <name>` macro-call name or
 *  the `implements <name>` typed reference — or undefined.  Capability refs
 *  resolve by name through the expander inventory, not a Langium cross-reference,
 *  so go-to-definition needs this explicit bridge. */
function capabilityNameAt(cst: CstNode): string | undefined {
  const ast = cst.astNode;
  if (ast && isMacroCall(ast) && cst.text === ast.name) return ast.name;
  if (ast && isImplementsDecl(ast) && ast.cap && cst.text === ast.cap) return ast.cap;
  return undefined;
}

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
  private readonly documents: LangiumDocuments;

  constructor(services: LangiumServices) {
    super(services);
    this.documents = services.shared.workspace.LangiumDocuments;
  }

  protected override collectLocationLinks(
    sourceCstNode: CstNode,
    params: DefinitionParams,
  ): MaybePromise<LocationLink[] | undefined> {
    // 1. Capability reference (`with <Cap>` / `implements <Cap>`) — handled
    //    first: the default treats a `MacroCall.name` token as its own
    //    declaration and returns a useless self-link, which would mask the real
    //    target.  We OWN navigation for capability names: jump to the
    //    `capability` declaration, or return nothing for a built-in (it has no
    //    source).  A non-capability `with` name (a real macro) is not handled
    //    here and falls through to the default.
    const cap = this.capabilityNav(sourceCstNode);
    if (cap.handled) return cap.link ? [cap.link] : undefined;

    // 2. If the default can resolve via cross-reference, prefer that.
    const fromDefault = super.collectLocationLinks(sourceCstNode, params);
    if (fromDefault) return fromDefault;

    // 3. Member-access fallback — tokens whose AST parent is a `MemberAccess`.
    const link = this.memberAccessLink(sourceCstNode);
    return link ? [link] : undefined;
  }

  /** Resolve a `with <Cap>` / `implements <Cap>` token.  `handled` is true when
   *  the token names a capability (user-declared or built-in); `link` points at
   *  a user `capability` declaration, or is undefined for a built-in (no
   *  source).  When the name is not a capability (e.g. a macro), `handled` is
   *  false so the default provider runs. */
  private capabilityNav(sourceCstNode: CstNode): { handled: boolean; link?: LocationLink } {
    const name = capabilityNameAt(sourceCstNode);
    if (!name) return { handled: false };
    for (const doc of this.documents.all) {
      const root = doc.parseResult?.value as Model | undefined;
      if (!root) continue;
      for (const node of AstUtils.streamAllContents(root)) {
        if (!isCapability(node) || node.name !== name) continue;
        const targetCst = node.$cstNode;
        if (!targetCst) continue;
        const nameNode = this.nameProvider.getNameNode(node) ?? targetCst;
        return {
          handled: true,
          link: LocationLink.create(
            doc.textDocument.uri,
            targetCst.range,
            nameNode.range,
            sourceCstNode.range,
          ),
        };
      }
    }
    // A built-in capability (auditable / softDeletable / …) — a real capability
    // reference, but programmatic, so there is nowhere to navigate.
    if (builtinCapabilities().has(name)) return { handled: true };
    return { handled: false };
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
