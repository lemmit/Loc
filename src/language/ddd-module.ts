import { type Module, inject } from "langium";
import {
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
  type PartialLangiumSharedServices,
  createDefaultModule,
  createDefaultSharedModule,
} from "langium/lsp";
import { DddGeneratedModule, DddGeneratedSharedModule } from "./generated/module.js";
import { DddValidator, registerValidationChecks } from "./ddd-validator.js";
import { DddScopeComputation, DddScopeProvider } from "./ddd-scope.js";
import { DddHoverProvider } from "./lsp/ddd-hover.js";
import { DddNodeKindProvider } from "./lsp/ddd-node-kind.js";
import { DddDefinitionProvider } from "./lsp/ddd-definition.js";

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
  return { shared, Ddd };
}
