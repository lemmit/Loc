import type { EnrichedLoomModel } from "../types/loom-ir.js";
import { allContexts } from "../types/loom-ir.js";
import { validateApplicationHandlers, validateRoutes } from "./checks/api-checks.js";
import { validateStampReadsBeforeFlush } from "./checks/capability-checks.js";
import type { LoomDiagnostic } from "./checks/diagnostic.js";
import { validateDomainServices } from "./checks/domain-service-checks.js";
import { validateIndexSuggestions } from "./checks/index-suggestion-checks.js";
import { validateProjections } from "./checks/projection-checks.js";
import {
  validateQueryableWheres,
  validateRawSeedColumns,
  validateRetrievals,
  validateViewGates,
} from "./checks/query-checks.js";
import { validateStores } from "./checks/store-checks.js";
import {
  validateCurrentUserScope,
  validateDuplicateTables,
  validateEventSourcedDiscipline,
  validateExprIntegrity,
  validateExternOperations,
  validateFindNameCollisions,
  validateFunctionBlockBodies,
  validateGenericInstancesUnimplemented,
  validateOperationReturnsUnimplemented,
  validatePermissionRefs,
  validateUnionFindShapes,
  validateUnionsUnimplemented,
  validateUniqueColumns,
  validateUnmappedErrorStatuses,
  validateVariantMatch,
  validateWhenGateSupport,
  validateWorkspaceUniqueness,
} from "./checks/structural-checks.js";
import {
  backendPlatformsHostingEachContext,
  validateAuditedOperationSupport,
  validateAuth,
  validateAuthUiFramework,
  validateComposeUniqueness,
  validateContextFilterSupport,
  validateDapperSupport,
  validateDataSourceCoverage,
  validateDataSourceUnwiredKnobs,
  validateDefaultDeny,
  validateDotnetStampSupport,
  validateElixirOpSelfCallPosition,
  validateElixirStampSupport,
  validateEventSourcedStorage,
  validateEventSourcedWorkflowStorage,
  validateFilterBypassSupport,
  validateFindPredicateAdapterSupport,
  validateInheritanceStorage,
  validateJavaContainmentSupport,
  validateJavaFullstackSupport,
  validateJavaProjectionFieldSupport,
  validateJavaSagaInstanceFieldSupport,
  validateJavaStampSupport,
  validateJavaViewFollowsSupport,
  validateMikroOrmSupport,
  validateNeedCapabilities,
  validateNodeStampSupport,
  validatePermissions,
  validateProvenancedStorage,
  validatePythonStampSupport,
  validateReactIdReferences,
  validateResourceConfig,
  validateSavingShapeSupport,
  validateSystem,
  validateVanillaContainmentSupport,
  validateVanillaDocumentScope,
} from "./checks/system-checks.js";
import { validateTenancy } from "./checks/tenancy-checks.js";
import { validateAggregateTestBodies } from "./checks/test-checks.js";
import { validateUiBodies } from "./checks/ui-checks.js";
import {
  validateEventChannelAmbiguous,
  validateEventConsumersCarried,
  validateViews,
  validateWorkflows,
} from "./checks/workflow-checks.js";

// Public surface kept stable: LoomDiagnostic (now defined in checks/diagnostic)
// and firstNonQueryableNode (in checks/shared) are re-exported here so existing
// importers of "./validate.js" are unaffected.
export type { LoomDiagnostic } from "./checks/diagnostic.js";
export { firstNonQueryableNode } from "./checks/shared.js";

// ---------------------------------------------------------------------------
// Loom IR validator — semantic checks that need the full IR (not just
// the AST).  Runs after `enrichLoomModel`; abort generation on
// non-empty `errors`.
//
// This module is the orchestrator: `validateLoomModel` drives the
// per-theme check modules under `./checks/` (system / query / test /
// workflow / structural), each an independent fan-out leaf that pushes
// into the shared `diags` array.  Adding a check means adding a function
// to the relevant module and one call below.
//
// What this catches today: `test e2e` bodies referencing
// `api.<unknown>.<verb>` or `ui.<unknown>.<verb>`, or invoking an
// unknown verb on a known aggregate.  Previously these surfaced as
// thrown Errors from the e2e renderers — useful messages, but
// produced lazily during generation.  Doing it here means:
//
//   - Errors are collected up-front (one pass over the model), not
//     surfaced one-by-one as the renderer hits them.
//   - The CLI can decide whether to print all of them and abort,
//     vs. continuing past warnings.
//   - Renderers can assume the input is valid and stop carrying
//     defensive try/catch + descriptive-error logic.
// ---------------------------------------------------------------------------

export function validateLoomModel(loom: EnrichedLoomModel): LoomDiagnostic[] {
  const diags: LoomDiagnostic[] = [];
  // Workspace-scope uniqueness checks — only meaningful once a
  // project may span multiple `.ddd` files (Stage A multi-file).
  // Harmless for single-file projects: every collection is small
  // and the checks short-circuit when there are no duplicates.
  validateWorkspaceUniqueness(loom, diags);
  // `unique (...)` value-object column rejection (needs the resolved IR type).
  validateUniqueColumns(loom, diags);
  // System-wide: warn when a workflow event consumer subscribes to an event no
  // channel carries (it can't be dispatched in-process).  Needs every
  // context's channels, so it runs once over the whole model, not per-context.
  validateEventConsumersCarried([...allContexts(loom)], diags);
  // System-wide: warn when a consumer's event is carried by more than one
  // channel in its context (ambiguous in-process routing; first-by-declaration
  // wins).  Per-context internally, but gathered here alongside the carried check.
  validateEventChannelAmbiguous([...allContexts(loom)], diags);
  for (const sys of loom.systems) {
    validateSystem(sys, diags);
    validateComposeUniqueness(sys, diags);
    validateDuplicateTables(sys, diags);
    validateDataSourceCoverage(sys, diags);
    validateSavingShapeSupport(sys, diags);
    validateVanillaDocumentScope(sys, diags);
    validateElixirOpSelfCallPosition(sys, diags);
    validateContextFilterSupport(sys, diags);
    validateFilterBypassSupport(sys, diags);
    validateJavaContainmentSupport(sys, diags);
    validateJavaFullstackSupport(sys, diags);
    validateJavaStampSupport(sys, diags);
    validateDotnetStampSupport(sys, diags);
    validateNodeStampSupport(sys, diags);
    validatePythonStampSupport(sys, diags);
    validateElixirStampSupport(sys, diags);
    validateDapperSupport(sys, diags);
    validateMikroOrmSupport(sys, diags);
    validateFindPredicateAdapterSupport(sys, diags);
    validateVanillaContainmentSupport(sys, diags);
    validateNeedCapabilities(sys, diags);
    validateResourceConfig(sys, diags);
    validateDataSourceUnwiredKnobs(sys, diags);
    validateReactIdReferences(sys, diags);
    validateAuthUiFramework(sys, diags);
    validateDefaultDeny(sys, diags);
    validateAuth(sys, diags);
    validatePermissions(sys, diags);
    // Tenancy (multi-tenancy Phase 1a): registry existence, the explicit-
    // stance lint, marker-without-declaration, conflicting markers.
    validateTenancy(sys, diags);
    // Advisory index-suggestion lint (uniqueness-and-indexes.md §11,
    // D-INDEX-SUGGEST) — WARNING-severity `loom.index-suggestion` for a
    // query-filtered column with no covering index.  Never auto-derives; rides
    // the normal IR-warning channel (api → LSP / playground / `parse --json`).
    // Warning-only, so it can't flip `ok` or block generation (both error-gated).
    validateIndexSuggestions(sys, diags);
    // Scaffold expansion now runs at the AST level
    // (`src/language/ddd-scaffold-ast-expander.ts`).  Duplicate-page
    // detection happens through Langium's standard scope-walking
    // (every synthesised page is a real AST node, so two scaffolds
    // producing the same name surface as duplicate-symbol errors
    // from the linker).  The IR-level shim is gone.
    // Theme validation lives in the Langium-side validator
    // (`ddd-validator.ts:checkTheme`) where the raw AST is in
    // scope — unknown property names, duplicates, and the radius
    // enum are easier to catch there since lowering loses that
    // information by design.
  }
  // Which backend (needsDb) platforms host each context — drives the TPH
  // storage gate (sharedTable is implemented for Hono only, v1).
  const backendPlatformsByContext = backendPlatformsHostingEachContext(loom);
  // Per-context checks apply uniformly whether the context is
  // bundled in a system's modules or sits at the top level.
  for (const c of allContexts(loom)) {
    validateQueryableWheres(c, diags);
    validateViewGates(c, diags);
    validateRetrievals(c, diags);
    validateRawSeedColumns(c, diags);
    validateFindNameCollisions(c, diags);
    validateAggregateTestBodies(c, diags);
    validateDomainServices(c, diags);
    validateFunctionBlockBodies(c, diags);
    validateExternOperations(c, diags);
    validateStampReadsBeforeFlush(c, diags);
    validateEventSourcedDiscipline(c, diags);
    validateProjections(c, diags);
    validateWorkflows(c, diags);
    // Explicit application-layer handlers (unfoldable-api-derivation.md, Layer 3):
    // queryHandler-read-only + commandHandler-single-aggregate layering contracts.
    validateApplicationHandlers(c, diags);
    validateViews(c, diags);
    validateCurrentUserScope(c, diags);
    validatePermissionRefs(c, diags);
    validateGenericInstancesUnimplemented(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
    validateUnionsUnimplemented(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateUnionFindShapes(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateWhenGateSupport(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateOperationReturnsUnimplemented(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
    validateUnmappedErrorStatuses(c, diags);
    validateInheritanceStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateEventSourcedStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateEventSourcedWorkflowStorage(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
    validateProvenancedStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateAuditedOperationSupport(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateJavaViewFollowsSupport(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateJavaSagaInstanceFieldSupport(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
    validateJavaProjectionFieldSupport(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
  }
  validateExprIntegrity(loom, diags);
  // Explicit transport bindings (unfoldable-api-derivation.md, Layer 4): every
  // `route ... -> Context.Handler` target must resolve.  Whole-model (routes are
  // system-level, their targets cross-context).
  validateRoutes(loom, diags);
  validateVariantMatch(loom, diags);
  validateUiBodies(loom, diags);
  validateStores(loom, diags);
  return diags;
}
