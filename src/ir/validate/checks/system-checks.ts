// -------------------------------------------------------------------------
// System-level checks — thin barrel.  Packet 2.6 (wave-2) split the former
// 4.3k-line monolith into per-theme leaves below, the way validate.ts fans
// out to checks/; every name this module exported before the split is
// re-exported here unchanged, so `from "./checks/system-checks.js"` call
// sites (validate.ts, tests) needed no edits.
// -------------------------------------------------------------------------

export {
  validateAuth,
  validatePermissions,
} from "./auth-permission-checks.js";
export {
  validateElixirOpSelfCallPosition,
  validateJavaReservedIdentifiers,
} from "./backend-syntax-checks.js";
export {
  FILTER_BYPASS_FAMILIES,
  validateContextFilterSupport,
  validateFilterBypassSupport,
} from "./context-filter-checks.js";
export {
  validateDataSourceCoverage,
  validateDataSourceUnwiredKnobs,
  validateFileFieldObjectStorage,
  validateSavingShapeSupport,
  validateVanillaDocumentScope,
} from "./datasource-checks.js";
export { validateDefaultDeny } from "./default-deny-checks.js";
export {
  validateDapperSupport,
  validateFindPredicateAdapterSupport,
  validateMikroOrmSupport,
} from "./orm-adapter-checks.js";
export {
  validateGuardPrincipalWithoutAuth,
  validateStampSupport,
} from "./principal-guard-checks.js";
export {
  PAGED_QH_SUPPORTED,
  PROJECTION_AGG_SUPPORTED,
  PROJECTION_GROUPBY_SUPPORTED,
  PROJECTION_PROJ_SOURCE_SUPPORTED,
  PROJECTION_QT_SUPPORTED,
  PROJECTION_WF_SOURCE_SUPPORTED,
  validateColumnlessProjectionSources,
  validateDocumentAggregationBackend,
  validateDocumentAggregationFilters,
  validateGroupedProjectionBackend,
  validatePagedQueryHandlerBackend,
  validateProjectionSourceProjectionBackend,
  validateQueryTimeProjectionBackend,
  validateWholeTableAggregationBackend,
  validateWorkflowSourceProjectionBackend,
} from "./projection-backend-checks.js";
export { validateReactIdReferences } from "./react-id-reference-checks.js";
export {
  REMOTE_API_OP_UNSUPPORTED,
  validateApiResourceBindings,
  validateNeedCapabilities,
  validateRemoteApiOpSupport,
  validateResourceConfig,
} from "./resource-capability-checks.js";
export {
  backendPlatformsHostingEachContext,
  EVENT_SOURCING_BACKENDS,
  EVENT_SOURCING_WORKFLOW_BACKENDS,
  FIELD_MASK_BACKENDS,
  maskLaunderingEvents,
  validateAuditedOperationSupport,
  validateAuditedReturningOperationSupport,
  validateEventSourcedStorage,
  validateEventSourcedWorkflowStorage,
  validateFieldMask,
  validateInheritanceStorage,
  validateProvenancedStorage,
  validateTphFilterExpressibility,
} from "./storage-inheritance-checks.js";
export {
  validateChannelWiring,
  validateComposeUniqueness,
  validateRelayTargetNotSubscribed,
  validateSystem,
} from "./system-compose-channel-checks.js";
export {
  CHART_FRAMEWORKS,
  PROJECTION_READ_FRAMEWORKS,
  validateAuthUiFramework,
  validateChartSupport,
  validateCurrentUserNeedsAuthUi,
  validateDataGridFramework,
  validateFlutterPrimitiveSupport,
  validateHeexComponentHostState,
  validateUiProjectionReadFramework,
  validateUiRealtimeSupport,
} from "./ui-framework-checks.js";
