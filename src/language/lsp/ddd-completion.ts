import type { AstNodeDescription, MaybePromise } from "langium";
import { AstUtils } from "langium";
import {
  type CompletionAcceptor,
  type CompletionContext,
  DefaultCompletionProvider,
  type NextFeature,
} from "langium/lsp";
import { CompletionItemKind } from "vscode-languageserver";
import { isCollectionOp } from "../../util/collection-ops.js";
import {
  type EnumDecl,
  isAggregate,
  isBoundedContext,
  isContainment,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isEnumValue,
  isEventDecl,
  isFunctionDecl,
  isMemberSuffix,
  isNameRef,
  isOperation,
  isPostfixChain,
  isProperty,
  isValueObject,
} from "../generated/ast.js";
import {
  type DddType,
  envForNode,
  type MemberCompletion,
  membersOfType,
  resolveTypeRef,
  typeAfterSuffix,
  typeOf,
} from "../type-system.js";

// ---------------------------------------------------------------------------
// DddCompletionProvider — adds two extras to Langium's default
// completion provider:
//
//   1. Member-access completion: after a `.` on a typed receiver,
//      suggest the type's members (properties, containments, derived,
//      functions) plus collection ops on arrays.  The default doesn't
//      handle this because `MemberAccess.member` is a plain string
//      token, not a cross-reference.
//
//   2. Cross-reference label enrichment: every cross-ref completion
//      gets a `detail` string ("aggregate", "valueobject", "enum",
//      "event", …) so the popup is informative at a glance.
//
// Everything else (keyword completion, scope-driven candidates) is
// handled by the default and the existing `DddScopeProvider`
// (which already restricts containment-part lookup to the same
// aggregate).
// ---------------------------------------------------------------------------

export class DddCompletionProvider extends DefaultCompletionProvider {
  protected override completionFor(
    context: CompletionContext,
    next: NextFeature,
    acceptor: CompletionAcceptor,
  ): MaybePromise<void> {
    // Member-access arm: when the cursor is at the `member` slot of a
    // MemberAccess, emit type-driven member completions.
    if (this.isMemberAccessMemberSlot(context, next)) {
      this.completeMemberAccess(context, acceptor);
      // We still call super so keyword candidates aren't lost on the
      // off chance a MemberName overlaps a keyword.  In practice
      // there's no overlap (MemberName is `ID | 'id'`), so this is a
      // no-op safety net.
    }
    return super.completionFor(context, next, acceptor);
  }

  protected override createReferenceCompletionItem(nodeDescription: AstNodeDescription) {
    const item = super.createReferenceCompletionItem(nodeDescription);
    const detail = detailFor(nodeDescription);
    if (detail) {
      return { ...item, detail };
    }
    return item;
  }

  // -------------------------------------------------------------------------

  private isMemberAccessMemberSlot(context: CompletionContext, next: NextFeature): boolean {
    // Post grammar-flatten the member-name token lives on a
    // `MemberSuffix` rule: `next.type === "MemberSuffix"` AND
    // `next.property === "member"`.  Fall back to inspecting the AST
    // node at the cursor in case Langium produces a more nested
    // feature description for nested member chains.
    if (next.type === "MemberSuffix" && next.property === "member") return true;
    const node = context.node;
    return !!node && isMemberSuffix(node);
  }

  private completeMemberAccess(context: CompletionContext, acceptor: CompletionAcceptor): void {
    const node = context.node;
    if (!node || !isMemberSuffix(node)) return;
    // Receiver of a member suffix is the chain head plus any prior
    // suffixes' types — compute via the type system once.
    const chain = node.$container;
    if (!chain || !isPostfixChain(chain)) return;
    const idx = chain.suffixes.indexOf(node);
    if (idx < 0) return;
    // Build a "receiver" type by typing the head, then walking
    // every prior suffix in order.  `typeOf` is the entry point;
    // the suffix-walk lives inside typeOfPostfixChain — but since we
    // need the type AT this suffix (not after), we build a sub-chain
    // up to but not including `node` and type that.
    const env = envForNode(node);
    let receiverType = typeOf(chain.head, env);
    if (idx > 0) {
      for (let i = 0; i < idx; i++) {
        receiverType = typeAfterSuffix(receiverType, chain.suffixes[i]!, env);
      }
    }
    if (receiverType.kind !== "unknown") {
      this.emitMembersForType(receiverType, context, acceptor);
      return;
    }
    // Fallback: bare NameRef pointing at an EnumDecl visible in the
    // enclosing context (`Status.Active`).  The type system doesn't
    // type enum-name-as-expression today; we resolve it here for the
    // completion popup.
    if (idx === 0 && isNameRef(chain.head)) {
      const enumDecl = findEnumByName(node, chain.head.name);
      if (enumDecl) {
        for (const v of enumDecl.values) {
          acceptor(context, {
            label: v.name,
            kind: CompletionItemKind.EnumMember,
            detail: enumDecl.name,
          });
        }
      }
    }
  }

  private emitMembersForType(
    t: DddType,
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    // Single source of truth for "what members does this type have" lives in
    // `type-system.ts` (`membersOfType`), shared with the web Model builder.
    for (const m of membersOfType(t)) {
      acceptor(context, {
        label: m.name,
        kind: completionKindFor(m.kind),
        detail: m.detail,
      });
    }
  }
}

function completionKindFor(kind: MemberCompletion["kind"]): CompletionItemKind {
  switch (kind) {
    case "method":
      return CompletionItemKind.Method;
    case "enum-value":
      return CompletionItemKind.EnumMember;
    default:
      return CompletionItemKind.Field;
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function findEnumByName(from: import("langium").AstNode, name: string): EnumDecl | undefined {
  const ctx = AstUtils.getContainerOfType(from, isBoundedContext);
  if (!ctx) return undefined;
  for (const member of ctx.members) {
    if (isEnumDecl(member) && member.name === name) return member;
  }
  return undefined;
}

function detailFor(nd: AstNodeDescription): string | undefined {
  switch (nd.type) {
    case "Aggregate":
      return "aggregate";
    case "EntityPart":
      return "entity";
    case "ValueObject":
      return "valueobject";
    case "EnumDecl":
      return "enum";
    case "EnumValue":
      return "enum value";
    case "EventDecl":
      return "event";
    case "Subdomain":
      return "module";
    case "Deployable":
      return "deployable";
    case "Repository":
      return "repository";
    default:
      return undefined;
  }
}

// Re-export to keep ts happy if helpers above are tree-shaken.
void isAggregate;
void isContainment;
void isDerivedProp;
void isEntityPart;
void isEnumDecl;
void isEnumValue;
void isEventDecl;
void isFunctionDecl;
void isOperation;
void isProperty;
void isValueObject;
void isCollectionOp;
void resolveTypeRef;
