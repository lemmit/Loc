import { type Module, inject } from "langium";
import {
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
  createDefaultModule,
  createDefaultSharedModule,
} from "langium/lsp";
import { DddGeneratedModule, DddGeneratedSharedModule } from "./generated/module.js";
import { DddValidator, registerValidationChecks } from "./ddd-validator.js";
import { DddScopeComputation, DddScopeProvider } from "./ddd-scope.js";

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
};

export function createDddServices(context: DefaultSharedModuleContext): {
  shared: LangiumSharedServices;
  Ddd: DddServices;
} {
  const shared = inject(createDefaultSharedModule(context), DddGeneratedSharedModule);
  const Ddd = inject(createDefaultModule({ shared }), DddGeneratedModule, DddModule);
  shared.ServiceRegistry.register(Ddd);
  registerValidationChecks(Ddd);
  return { shared, Ddd };
}
