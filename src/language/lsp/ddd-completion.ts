import {
  DefaultCompletionProvider,
  type CompletionAcceptor,
  type CompletionContext,
  type LangiumServices,
  type NextFeature,
} from "langium/lsp";
import type {
  AstNodeDescription,
  MaybePromise,
} from "langium";
import {
  CompletionItemKind,
} from "vscode-languageserver";
import {
  isAggregate,
  isBoundedContext,
  isContainment,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isEnumValue,
  isEventDecl,
  isFunctionDecl,
  isMemberAccess,
  isNameRef,
  isOperation,
  isProperty,
  isValueObject,
  type EnumDecl,
} from "../generated/ast.js";
import { AstUtils } from "langium";
import {
  envForNode,
  iterateEntityMembers,
  isCollectionOp,
  resolveTypeRef,
  typeOf,
  typeToString,
  type DddType,
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

const COLLECTION_OPS: ReadonlyArray<{ name: string; signature: string }> = [
  { name: "count", signature: "int" },
  { name: "sum", signature: "(λ): decimal" },
  { name: "all", signature: "(λ): bool" },
  { name: "any", signature: "(λ): bool" },
  { name: "where", signature: "(λ): T[]" },
  { name: "first", signature: "T" },
  { name: "firstOrNull", signature: "T?" },
];

export class DddCompletionProvider extends DefaultCompletionProvider {
  constructor(services: LangiumServices) {
    super(services);
  }

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

  protected override createReferenceCompletionItem(
    nodeDescription: AstNodeDescription,
  ) {
    const item = super.createReferenceCompletionItem(nodeDescription);
    const detail = detailFor(nodeDescription);
    if (detail) {
      return { ...item, detail };
    }
    return item;
  }

  // -------------------------------------------------------------------------

  private isMemberAccessMemberSlot(
    context: CompletionContext,
    next: NextFeature,
  ): boolean {
    // The most reliable signal: `next.type === "MemberAccess"` AND
    // `next.property === "member"`.  Fall back to inspecting the AST
    // node at the cursor in case Langium produces a more nested
    // feature description for nested member chains.
    if (next.type === "MemberAccess" && next.property === "member") return true;
    const node = context.node;
    return !!node && isMemberAccess(node);
  }

  private completeMemberAccess(
    context: CompletionContext,
    acceptor: CompletionAcceptor,
  ): void {
    const node = context.node;
    if (!node || !isMemberAccess(node)) return;
    const receiver = node.receiver;
    if (!receiver) return;

    const env = envForNode(node);
    const receiverType = typeOf(receiver, env);
    if (receiverType.kind !== "unknown") {
      this.emitMembersForType(receiverType, context, acceptor);
      return;
    }
    // Fallback: bare NameRef pointing at an EnumDecl visible in the
    // enclosing context (`Status.Active`).  The type system doesn't
    // type enum-name-as-expression today; we resolve it here for the
    // completion popup.
    if (isNameRef(receiver)) {
      const enumDecl = findEnumByName(node, receiver.name);
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
    if (t.kind === "array") {
      for (const op of COLLECTION_OPS) {
        acceptor(context, {
          label: op.name,
          kind: CompletionItemKind.Method,
          detail: `collection op: ${op.signature}`,
        });
      }
      return;
    }

    if (t.kind === "entity" || t.kind === "aggregate") {
      // Magic `id` accessor — every entity / aggregate has one.
      const idType = `Id<${t.ref.name}>`;
      acceptor(context, {
        label: "id",
        kind: CompletionItemKind.Field,
        detail: idType,
      });
      const members = iterateEntityMembers(t.ref);
      for (const m of members) {
        acceptor(context, completionItemForMember(m));
      }
      return;
    }

    if (t.kind === "valueobject") {
      const members = iterateEntityMembers(t.ref);
      for (const m of members) {
        acceptor(context, completionItemForMember(m));
      }
      return;
    }

    if (t.kind === "primitive" && t.name === "string") {
      acceptor(context, {
        label: "length",
        kind: CompletionItemKind.Field,
        detail: "int",
      });
      return;
    }

    if (t.kind === "enum") {
      // Enum-value access: `Status.Active`, `Status.Closed`, …
      for (const v of t.ref.values) {
        acceptor(context, {
          label: v.name,
          kind: CompletionItemKind.EnumMember,
          detail: t.ref.name,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function completionItemForMember(m: ReturnType<typeof iterateEntityMembers>[number]) {
  switch (m.kind) {
    case "property":
      return {
        label: m.name,
        kind: CompletionItemKind.Field,
        detail: typeToString(m.type),
      };
    case "containment":
      return {
        label: m.name,
        kind: CompletionItemKind.Field,
        detail: typeToString(m.type),
      };
    case "derived":
      return {
        label: m.name,
        kind: CompletionItemKind.Property,
        detail: `derived: ${typeToString(m.type)}`,
      };
    case "function":
      return {
        label: m.name,
        kind: CompletionItemKind.Function,
        detail: `function: ${typeToString(m.type)}`,
      };
    case "operation":
      return {
        label: m.name,
        kind: CompletionItemKind.Method,
        detail: "operation",
      };
  }
}

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
    case "Module":
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
