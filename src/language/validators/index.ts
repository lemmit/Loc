// Barrel: re-exports the themed validator entry points so the
// dispatcher in `ddd-validator.ts` (and any future direct caller)
// can pull them from a single import.

export { checkBuilderCallType, checkLegacyConstructorCalls } from "./builder-call.js";
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
export { checkGenericCarriers } from "./generics.js";
export { checkInheritance } from "./inheritance.js";
export { checkMacroExpansion } from "./macros.js";
export { checkMatchExpressions, checkMatcherArity, checkMatchesCalls } from "./match.js";
export { checkPayloads } from "./payload.js";
export { checkSeeds } from "./seed.js";
export {
  checkAssignOrCall,
  checkCallStmt,
  checkEmit,
  checkOperation,
  checkStatement,
} from "./statements.js";
export {
  checkAggregate,
  checkContainment,
  checkContext,
  checkEntityPart,
  checkSlotTypePosition,
  checkTypeReferences,
  checkValueObject,
} from "./structural.js";
export { checkTraceability } from "./traceability.js";
export {
  checkBinaryOperands,
  checkDerived,
  checkFunction,
  checkInvariant,
  checkPrimitiveConversions,
  checkPropertyCheck,
  checkSingleBinaryOperands,
  checkSinglePrimitiveConversion,
  checkSlotMemberAccess,
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
