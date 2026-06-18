import { AstUtils, DefaultIndexManager, inject, type LangiumDocument, type Module } from "langium";
import {
  createDefaultModule,
  createDefaultSharedModule,
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
  type PartialLangiumSharedServices,
} from "langium/lsp";
import { bootMacros } from "../macros/index.js";
import { DddScopeComputation, DddScopeProvider } from "./ddd-scope.js";
import { DddValidator, registerValidationChecks } from "./ddd-validator.js";
import { isAggregate, isBoundedContext, isUi } from "./generated/ast.js";
import { DddGeneratedModule, DddGeneratedSharedModule } from "./generated/module.js";
import { DddCodeActionProvider } from "./lsp/ddd-code-actions.js";
import { DddCompletionProvider } from "./lsp/ddd-completion.js";
import { DddDefinitionProvider } from "./lsp/ddd-definition.js";
import { DddHoverProvider } from "./lsp/ddd-hover.js";
import { DddNodeKindProvider } from "./lsp/ddd-node-kind.js";
import { DddReferencesProvider } from "./lsp/ddd-references.js";
import { DddRenameProvider } from "./lsp/ddd-rename.js";
import { DddSemanticTokenProvider } from "./lsp/ddd-semantic-tokens.js";
import { DddSignatureHelpProvider } from "./lsp/ddd-signature-help.js";

export type DddAddedServices = {
  validation: {
    DddValidator: DddValidator;
  };
};

export type DddServices = LangiumServices & DddAddedServices;

export const DddModule: Module<DddServices, PartialLangiumServices & DddAddedServices> = {
  validation: {
    DddValidator: (services) => new DddValidator(services as DddServices),
  },
  references: {
    ScopeProvider: (services: LangiumServices) => new DddScopeProvider(services),
    ScopeComputation: (services: LangiumServices) => new DddScopeComputation(services),
  },
  lsp: {
    HoverProvider: (services: LangiumServices) => new DddHoverProvider(services),
    DefinitionProvider: (services: LangiumServices) => new DddDefinitionProvider(services),
    CompletionProvider: (services: LangiumServices) => new DddCompletionProvider(services),
    ReferencesProvider: (services: LangiumServices) => new DddReferencesProvider(services),
    RenameProvider: (services: LangiumServices) => new DddRenameProvider(services),
    SemanticTokenProvider: (services: LangiumServices) => new DddSemanticTokenProvider(services),
    SignatureHelp: () => new DddSignatureHelpProvider(),
    CodeActionProvider: () => new DddCodeActionProvider(),
  },
};

/** True when a document contains any macro host (`with X(...)` on an
 *  aggregate / ui / context).  Cheap early-exit walk used by the affected-doc
 *  override below. */
function hasMacroHost(document: LangiumDocument): boolean {
  const root = document.parseResult?.value;
  if (!root) return false;
  for (const node of AstUtils.streamAllContents(root)) {
    if (
      (isAggregate(node) || isUi(node) || isBoundedContext(node)) &&
      node.withClause !== undefined
    ) {
      return true;
    }
  }
  return false;
}

/** Macro ref-list arguments (`with scaffold(subdomains: [Sales, ...])`) are
 *  resolved by *name* against the whole workspace during the pre-link
 *  expansion pass — they are deliberately not Langium cross-references (the
 *  expander runs before linking).  As a result the default affected-doc
 *  computation, which keys off resolved cross-references, never re-validates a
 *  macro-host document when a *sibling* file it names is added, changed, or
 *  removed.  In a multi-file project that leaves a stale "references unknown
 *  Subdomain" error on the scaffold line even after the target file loads.
 *
 *  We widen `isAffected` so any macro-host document is reconsidered whenever
 *  the workspace document set changes; the validator's
 *  `collectUnresolvedMacroRefs` re-resolves the refs against the now-settled
 *  workspace, clearing spurious errors (and keeping genuine ones). */
class DddIndexManager extends DefaultIndexManager {
  override isAffected(document: LangiumDocument, changedUris: Set<string>): boolean {
    if (super.isAffected(document, changedUris)) return true;
    if (changedUris.size === 0) return false;
    return hasMacroHost(document);
  }
}

// Shared-level overrides (services that live on `LangiumSharedServices`,
// not the per-language `LangiumServices`).  NodeKindProvider drives the
// icons on workspace-symbol search results and completion items —
// without overriding it, every Loom symbol gets `SymbolKind.Field`.
// IndexManager widens affected-doc detection for macro hosts (see above).
export const DddSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
  lsp: {
    NodeKindProvider: () => new DddNodeKindProvider(),
  },
  workspace: {
    IndexManager: (services: LangiumSharedServices) => new DddIndexManager(services),
  },
};

export function createDddServices(context: DefaultSharedModuleContext): {
  shared: LangiumSharedServices;
  Ddd: DddServices;
} {
  const shared = inject(
    createDefaultSharedModule(context),
    DddGeneratedSharedModule,
    DddSharedModule,
  );
  const Ddd = inject(createDefaultModule({ shared }), DddGeneratedModule, DddModule);
  shared.ServiceRegistry.register(Ddd);
  registerValidationChecks(Ddd);
  // Macro expander — registry-driven `with X(...)` expansion.
  // Runs as a DocumentState.IndexedContent hook (after indexing,
  // before ComputedScopes/Linked) so synthesised members
  // participate in scope resolution and validation as if user-
  // written.  Replaces the legacy scaffold AST expander, which
  // was deleted when `scaffold` migrated to a stdlib macro.
  bootMacros(shared);
  return { shared, Ddd };
}
