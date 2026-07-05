import { DefaultIndexManager, inject, type LangiumDocument, type Module } from "langium";
import {
  createDefaultModule,
  createDefaultSharedModule,
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
  type PartialLangiumSharedServices,
} from "langium/lsp";
import { bootMacros, getMacroRefDeps } from "../macros/index.js";
import { DddScopeComputation, DddScopeProvider } from "./ddd-scope.js";
import { DddValidator, registerValidationChecks } from "./ddd-validator.js";
import { DddGeneratedModule, DddGeneratedSharedModule } from "./generated/module.js";
import { DddCodeActionProvider } from "./lsp/ddd-code-actions.js";
import { DddCompletionProvider } from "./lsp/ddd-completion.js";
import { DddDefinitionProvider } from "./lsp/ddd-definition.js";
import { DddHoverProvider } from "./lsp/ddd-hover.js";
import { DddImplementationProvider } from "./lsp/ddd-implementation.js";
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
    ImplementationProvider: (services: LangiumServices) => new DddImplementationProvider(services),
  },
};

/** Diagnostic codes for Loom's *by-name, cross-document* references — names
 *  resolved against the workspace in the validator rather than through
 *  Langium's linker (so the default affected-doc computation can't see them).
 *  A document carrying one of these is "hungry": a file that loads later may
 *  satisfy it, so it must be reconsidered on any workspace change — the direct
 *  analogue of Langium retrying documents whose Langium references error.
 *  (`loom.unknown-builder-type` is emitted by `validators/builder-call.ts` for
 *  unresolved top-level component references in page bodies.) */
const BY_NAME_XREF_CODES: ReadonlySet<string | number> = new Set(["loom.unknown-builder-type"]);

function hasUnresolvedByNameXref(document: LangiumDocument): boolean {
  return (document.diagnostics ?? []).some(
    (d) => d.code !== undefined && BY_NAME_XREF_CODES.has(d.code),
  );
}

/** Macro ref-list arguments (`with scaffold(subdomains: [Sales, ...])`) — and,
 *  more broadly, Loom's by-name cross-document references (top-level
 *  components in page bodies, etc.) — are resolved by *name* against the
 *  workspace in the validator, not through Langium's linker.  The default
 *  affected-doc computation keys off resolved cross-references, so it never
 *  re-validates such a document when a *sibling* it names is added, changed, or
 *  removed — leaving a stale "references unknown …" error after the target
 *  file loads.
 *
 *  Rather than re-validate every macro host on every edit, we mirror Langium's
 *  own reference-index + linking-error-retry approach.  A document is affected
 *  when
 *   - the validator recorded a still-unresolved macro ref (`MacroRefDeps`), or
 *     it currently carries any by-name cross-doc diagnostic — retry on any
 *     change, since a newly *added* provider isn't parsed yet at this point
 *     (exactly as Langium retries documents with linking errors); or
 *   - one of the documents its macro refs resolved into is in the changed set
 *     (a provider was edited or removed).
 *  Clean documents with unrelated edits are left untouched. */
class DddIndexManager extends DefaultIndexManager {
  override isAffected(document: LangiumDocument, changedUris: Set<string>): boolean {
    if (super.isAffected(document, changedUris)) return true;
    if (changedUris.size === 0) return false;
    if (hasUnresolvedByNameXref(document)) return true;
    const deps = getMacroRefDeps(document);
    if (!deps) return false;
    if (deps.unresolved) return true;
    for (const providerUri of deps.providers) {
      if (changedUris.has(providerUri)) return true;
    }
    return false;
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
