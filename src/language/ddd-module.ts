import { inject, type Module } from "langium";
import {
  createDefaultModule,
  createDefaultSharedModule,
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
  type PartialLangiumSharedServices,
} from "langium/lsp";
import { registerScaffoldAstExpander } from "./ddd-scaffold-ast-expander.js";
import { DddScopeComputation, DddScopeProvider } from "./ddd-scope.js";
import { DddValidator, registerValidationChecks } from "./ddd-validator.js";
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
    DddValidator: () => new DddValidator(),
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

// Shared-level overrides (services that live on `LangiumSharedServices`,
// not the per-language `LangiumServices`).  NodeKindProvider drives the
// icons on workspace-symbol search results and completion items —
// without overriding it, every Loom symbol gets `SymbolKind.Field`.
export const DddSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
  lsp: {
    NodeKindProvider: () => new DddNodeKindProvider(),
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
  // AST-to-AST scaffold expansion.  Registers a
  // DocumentState.IndexedContent hook that synthesises Page AST nodes
  // for every Scaffold directive — it runs after indexing but before
  // ComputedScopes/Linked, so a `[Page:ID]` ref to a scaffold-derived
  // name resolves through Langium's standard machinery.
  registerScaffoldAstExpander(shared);
  return { shared, Ddd };
}
