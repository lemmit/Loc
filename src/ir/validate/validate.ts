import type { EnrichedLoomModel } from "../types/loom-ir.js";
import { allContexts } from "../types/loom-ir.js";
import type { LoomDiagnostic } from "./checks/diagnostic.js";
import { validateQueryableWheres, validateRetrievals } from "./checks/query-checks.js";
import {
  validateCurrentUserScope,
  validateEventSourcedDiscipline,
  validateExprIntegrity,
  validateExternOperations,
  validateFindNameCollisions,
  validateGenericInstancesUnimplemented,
  validatePermissionRefs,
  validateUnionsUnimplemented,
  validateWorkspaceUniqueness,
} from "./checks/structural-checks.js";
import {
  backendPlatformsHostingEachContext,
  validateAuditedOperationSupport,
  validateAuth,
  validateContextFilterSupport,
  validateDapperSupport,
  validateDataSourceCoverage,
  validateDataSourceUnwiredKnobs,
  validateEventSourcedStorage,
  validateInheritanceStorage,
  validateMikroOrmSupport,
  validateNeedCapabilities,
  validatePermissions,
  validateProvenancedStorage,
  validateReactIdReferences,
  validateResourceConfig,
  validateSavingShapeSupport,
  validateSystem,
} from "./checks/system-checks.js";
import { validateAggregateTestBodies } from "./checks/test-checks.js";
import { validateViews, validateWorkflows } from "./checks/workflow-checks.js";

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
  for (const sys of loom.systems) {
    validateSystem(sys, diags);
    validateDataSourceCoverage(sys, diags);
    validateSavingShapeSupport(sys, diags);
    validateContextFilterSupport(sys, diags);
    validateDapperSupport(sys, diags);
    validateMikroOrmSupport(sys, diags);
    validateNeedCapabilities(sys, diags);
    validateResourceConfig(sys, diags);
    validateDataSourceUnwiredKnobs(sys, diags);
    validateReactIdReferences(sys, diags);
    validateAuth(sys, diags);
    validatePermissions(sys, diags);
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
    validateRetrievals(c, diags);
    validateFindNameCollisions(c, diags);
    validateAggregateTestBodies(c, diags);
    validateExternOperations(c, diags);
    validateEventSourcedDiscipline(c, diags);
    validateWorkflows(c, diags);
    validateViews(c, diags);
    validateCurrentUserScope(c, diags);
    validatePermissionRefs(c, diags);
    validateGenericInstancesUnimplemented(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
    validateUnionsUnimplemented(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateInheritanceStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateEventSourcedStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateProvenancedStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateAuditedOperationSupport(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
  }
  validateExprIntegrity(loom, diags);
  return diags;
}
