import type { AstNode, AstNodeDescription } from "langium";
import { DefaultNodeKindProvider } from "langium/lsp";
import { CompletionItemKind, SymbolKind } from "vscode-languageserver";

// ---------------------------------------------------------------------------
// DddNodeKindProvider — maps Loom AST node types to LSP symbol /
// completion kinds.  Workspace-symbol search (Cmd+T in VS Code) and
// completion-item icons read these to pick the right icon.
//
// The default returns `SymbolKind.Field` and `CompletionItemKind.Reference`
// for everything — uniform but not informative.  We override based on
// the node's `$type` since shared services see node descriptions that
// only carry the type name.
// ---------------------------------------------------------------------------

export class DddNodeKindProvider extends DefaultNodeKindProvider {
  override getSymbolKind(node: AstNode | AstNodeDescription): SymbolKind {
    switch (typeOf(node)) {
      case "Aggregate":
      case "EntityPart":
      case "ValueObject":
        return SymbolKind.Class;
      case "EnumDecl":
        return SymbolKind.Enum;
      case "EnumValue":
        return SymbolKind.EnumMember;
      case "EventDecl":
        return SymbolKind.Event;
      case "Property":
      case "Containment":
      case "DerivedProp":
        return SymbolKind.Field;
      case "FunctionDecl":
        return SymbolKind.Function;
      case "Operation":
        return SymbolKind.Method;
      case "Repository":
        return SymbolKind.Interface;
      case "FindDecl":
        return SymbolKind.Method;
      case "Module":
      case "BoundedContext":
        return SymbolKind.Module;
      case "System":
        return SymbolKind.Package;
      case "Deployable":
        return SymbolKind.Constructor;
      default:
        return SymbolKind.Field;
    }
  }

  override getCompletionItemKind(node: AstNode | AstNodeDescription): CompletionItemKind {
    switch (typeOf(node)) {
      case "Aggregate":
      case "EntityPart":
      case "ValueObject":
        return CompletionItemKind.Class;
      case "EnumDecl":
        return CompletionItemKind.Enum;
      case "EnumValue":
        return CompletionItemKind.EnumMember;
      case "EventDecl":
        return CompletionItemKind.Event;
      case "Property":
      case "Containment":
      case "DerivedProp":
        return CompletionItemKind.Field;
      case "FunctionDecl":
        return CompletionItemKind.Function;
      case "Operation":
        return CompletionItemKind.Method;
      case "FindDecl":
        return CompletionItemKind.Method;
      case "Module":
      case "BoundedContext":
        return CompletionItemKind.Module;
      default:
        return CompletionItemKind.Reference;
    }
  }
}

function typeOf(node: AstNode | AstNodeDescription): string {
  // AstNodeDescription carries `type`; AstNode has `$type`.
  if ("type" in node && typeof node.type === "string") return node.type;
  return (node as AstNode).$type;
}
