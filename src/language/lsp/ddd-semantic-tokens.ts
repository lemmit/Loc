import type { AstNode } from "langium";
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from "langium/lsp";
import { SemanticTokenTypes } from "vscode-languageserver";
import {
  isAggregate,
  isContainment,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isEnumValue,
  isEventDecl,
  isFunctionDecl,
  isIdType,
  isMemberSuffix,
  isNamedType,
  isNameRef,
  isOperation,
  isParameter,
  isPostfixChain,
  isProperty,
  isRepository,
  isValueObject,
  type MemberSuffix,
  type NameRef,
} from "../generated/ast.js";
import { envForNode, stepIntoNode, typeAfterSuffix, typeOf } from "../type-system.js";

// ---------------------------------------------------------------------------
// DddSemanticTokenProvider — layers resolved-meaning colour over the
// TextMate grammar.  Declarations get their kind (type / enum / property /
// method / parameter); type references and member accesses are coloured by
// what they resolve to via the type system, so an `X id` target reads as a
// type and `order.total` reads as a property even though both are plain ID
// tokens TextMate can't classify.
// ---------------------------------------------------------------------------

export class DddSemanticTokenProvider extends AbstractSemanticTokenProvider {
  protected override highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
    // biome-ignore lint/suspicious/noConfusingVoidType: must match the overridden AbstractSemanticTokenProvider.highlightElement signature.
  ): void | "prune" {
    if (isAggregate(node) || isEntityPart(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.class });
    } else if (isValueObject(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.struct });
    } else if (isEnumDecl(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.enum });
    } else if (isEnumValue(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.enumMember });
    } else if (isEventDecl(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.event });
    } else if (isProperty(node) || isContainment(node) || isDerivedProp(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.property });
    } else if (isFunctionDecl(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.function });
    } else if (isOperation(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.method });
    } else if (isParameter(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.parameter });
    } else if (isRepository(node)) {
      acceptor({ node, property: "name", type: SemanticTokenTypes.type });
    } else if (isIdType(node) || isNamedType(node)) {
      acceptor({ node, property: "target", type: SemanticTokenTypes.type });
    } else if (isNameRef(node)) {
      this.highlightNameRef(node, acceptor);
    } else if (isMemberSuffix(node)) {
      this.highlightMember(node, acceptor);
    }
  }

  private highlightNameRef(node: NameRef, acceptor: SemanticTokenAcceptor): void {
    acceptor({ node, property: "name", type: SemanticTokenTypes.variable });
  }

  private highlightMember(node: MemberSuffix, acceptor: SemanticTokenAcceptor): void {
    const chain = node.$container;
    if (!isPostfixChain(chain)) return;
    const idx = chain.suffixes.indexOf(node);
    if (idx < 0) return;
    const env = envForNode(node);
    let recvType = typeOf(chain.head, env);
    for (let i = 0; i < idx; i++) {
      recvType = typeAfterSuffix(recvType, chain.suffixes[i]!, env);
    }
    const decl = stepIntoNode(recvType, node.member);
    const type =
      decl && (isFunctionDecl(decl) || isOperation(decl))
        ? SemanticTokenTypes.method
        : SemanticTokenTypes.property;
    acceptor({ node, property: "member", type });
  }
}
