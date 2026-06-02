// Barrel: re-exports the themed validator entry points so the
// dispatcher in `ddd-validator.ts` (and any future direct caller)
// can pull them from a single import.

export { checkBuilderCallType, checkLegacyConstructorCalls } from "./builder-call.js";
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
export { checkMacroExpansion } from "./macros.js";
export { checkMatchExpressions, checkMatcherArity, checkMatchesCalls } from "./match.js";
export { checkPayloads } from "./payload.js";
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
} from "./types.js";
export {
  checkApiBodyRefs,
  checkLayout,
  checkMenuBlock,
  checkPage,
  checkTheme,
  checkUi,
  checkUiHelperImports,
} from "./ui.js";
