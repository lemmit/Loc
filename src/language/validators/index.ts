// Barrel: re-exports the themed validator entry points so the
// dispatcher in `ddd-validator.ts` (and any future direct caller)
// can pull them from a single import.

export { checkIconOnlyButtonName, checkImageAltText, checkThemeContrast } from "./a11y.js";
export { checkAuthBlock } from "./auth.js";
export {
  checkBindableInputArgs,
  checkBuilderCallType,
  checkConstructionFields,
  checkFactoryCreateFields,
  checkFileUploadBinding,
  checkLegacyConstructorCalls,
} from "./builder-call.js";
export { checkChannels } from "./channel.js";
export { checkProjectSingletons, checkTopLevelDomainComposition } from "./composition.js";
export { checkCriteria } from "./criterion.js";
export { checkDataSource } from "./datasource.js";
export {
  checkDeployable,
  checkDeployableDataSources,
  checkDeployableDesignPack,
  checkDeployablePlatform,
  checkDeployableServes,
  checkDeployableUiCompose,
} from "./deployable.js";
export { checkDuplicateNames } from "./duplicates.js";
export { checkGenericCarriers, checkSelfType } from "./generics.js";
export { checkHandlerBodies } from "./handlers.js";
export { checkInheritance } from "./inheritance.js";
export { checkMacroExpansion } from "./macros.js";
export {
  checkExpectMatcher,
  checkMatchExpressions,
  checkMatcherArity,
  checkMatchesCalls,
} from "./match.js";
export { checkMigrations } from "./migration.js";
export { checkUnknownNameRefs } from "./names.js";
export { checkPayloads } from "./payload.js";
export { checkPolicyFns } from "./policy-fn.js";
export { checkRepositoryFinds } from "./repository.js";
export { checkSeeds } from "./seed.js";
export {
  checkAssignOrCall,
  checkCallStmt,
  checkConstructionArgTypes,
  checkEmit,
  checkOperation,
  checkRetrievalLiteral,
  checkStatement,
} from "./statements.js";
export {
  checkActionTypePosition,
  checkAggregate,
  checkAmbiguousPartRefs,
  checkContainment,
  checkContext,
  checkEntityPart,
  checkSlotTypePosition,
  checkTypeReferences,
  checkValueObject,
} from "./structural.js";
export { checkTemplateHoles } from "./template.js";
export { checkDurationConstructors } from "./temporal.js";
export { checkOrgPathReferences, checkTenancyDecls } from "./tenancy.js";
export { checkTestPlacement } from "./test-placement.js";
export { checkTimers } from "./timer.js";
export { checkTopLevelFunctions } from "./toplevel-function.js";
export { checkTraceability } from "./traceability.js";
export {
  checkAvgProjection,
  checkBinaryOperands,
  checkDerived,
  checkFunction,
  checkIntrinsicCalls,
  checkInvariant,
  checkPrimitiveConversions,
  checkPropertyCheck,
  checkSingleBinaryOperands,
  checkSinglePrimitiveConversion,
  checkSingleTernary,
  checkSlotMemberAccess,
  checkTernaryExprs,
  checkUnknownMemberAccess,
} from "./types.js";
export {
  checkApiBodyRefs,
  checkComponent,
  checkLayout,
  checkMenuBlock,
  checkPage,
  checkTheme,
  checkUi,
} from "./ui.js";
export { checkUnions } from "./unions.js";
