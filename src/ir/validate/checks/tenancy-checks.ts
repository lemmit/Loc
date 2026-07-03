import type { SystemIR } from "../../types/loom-ir.js";
import { classifyTenantStance, hasTenantOwned } from "../../util/tenant-stance.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Tenancy checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §1).
//
// The AST-level tenancy rules (duplicate `tenancy by`, unknown claim field)
// live in `src/language/validators/tenancy.ts`; this leaf owns everything
// that needs the merged, fully-lowered model:
//
//   - the `of <Registry>` target must exist as an aggregate in the system
//     (`loom.tenancy-registry-unknown`)
//   - the explicit-stance lint: under a `tenancy by` system every
//     row-persisting aggregate must pick a side — `with tenantOwned`
//     (tenant data) or `crossTenant` (shared data)
//     (`loom.tenancy-stance-unmarked`).  The registry is exempt (self-keyed;
//     neither marker fits — a *marked* registry is
//     `loom.tenancy-registry-marked`), and so are `abstract` bases (they
//     persist no rows of their own — no repository, no table; the
//     requirement falls on the TPC/TPH concretes, which do NOT inherit the
//     base's capability record).
//   - stance markers without a `tenancy by` declaration:
//     `loom.tenant-owned-without-tenancy` (error — the capability stamps and
//     filters by a claim no declaration names) and
//     `loom.cross-tenant-without-tenancy` (warning — intent declared,
//     nothing to opt out of)
//   - `loom.tenancy-conflicting-stance` — both markers on one aggregate.
//
// Stance is DERIVED per aggregate via `classifyTenantStance`
// (`src/ir/util/tenant-stance.ts`) — never stamped on the IR.
// ---------------------------------------------------------------------------

export function validateTenancy(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const tenancy = sys.tenancy;

  // Registry existence — `of <Registry>` must name an aggregate somewhere
  // in the system (any context of any subdomain).
  if (tenancy) {
    const registryExists = sys.subdomains.some((mod) =>
      mod.contexts.some((ctx) => ctx.aggregates.some((a) => a.name === tenancy.registryName)),
    );
    if (!registryExists) {
      diags.push({
        severity: "error",
        code: "loom.tenancy-registry-unknown",
        message:
          `system '${sys.name}': tenancy registry '${tenancy.registryName}' does not name an ` +
          `aggregate in the system.  Declare 'aggregate ${tenancy.registryName} { ... }' or ` +
          `point 'of' at an existing aggregate.`,
        source: `${sys.name}/tenancy`,
      });
    }
  }

  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      for (const agg of ctx.aggregates) {
        const owned = hasTenantOwned(agg);
        const cross = agg.crossTenant === true;

        // Both markers on one aggregate are contradictory regardless of
        // whether the system declares tenancy at all.
        if (owned && cross) {
          diags.push({
            severity: "error",
            code: "loom.tenancy-conflicting-stance",
            message:
              `aggregate '${agg.name}' is marked both 'crossTenant' and 'with tenantOwned'; ` +
              `the stances are mutually exclusive — keep exactly one.`,
            source: `${ctx.name}/${agg.name}`,
          });
          continue;
        }

        if (!tenancy) {
          // Stance markers only mean something under a `tenancy by` system.
          if (owned) {
            diags.push({
              severity: "error",
              code: "loom.tenant-owned-without-tenancy",
              message:
                `aggregate '${agg.name}' implements 'tenantOwned' but system '${sys.name}' ` +
                `declares no 'tenancy by user.<claim> of <Registry>' line.  Add the tenancy ` +
                `declaration, or drop 'with tenantOwned'.`,
              source: `${ctx.name}/${agg.name}`,
            });
          }
          if (cross) {
            diags.push({
              severity: "warning",
              code: "loom.cross-tenant-without-tenancy",
              message:
                `aggregate '${agg.name}' is marked 'crossTenant' but system '${sys.name}' ` +
                `declares no 'tenancy by' line — there is no tenant scoping to opt out of, ` +
                `so the flag has no effect.`,
              source: `${ctx.name}/${agg.name}`,
            });
          }
          continue;
        }

        const stance = classifyTenantStance(agg, sys);

        // The registry is self-keyed — neither stance marker fits it.
        if (stance === "registry") {
          if (owned || cross) {
            diags.push({
              severity: "error",
              code: "loom.tenancy-registry-marked",
              message:
                `aggregate '${agg.name}' is the tenancy registry (named in ` +
                `'tenancy by ... of ${agg.name}') and must not be marked ` +
                `${owned ? "'with tenantOwned'" : "'crossTenant'"} — the registry is ` +
                `self-keyed; drop the marker.`,
              source: `${ctx.name}/${agg.name}`,
            });
          }
          continue;
        }

        // Explicit-stance lint: every row-persisting aggregate under a
        // tenancy system must pick a side.  Abstract bases are exempt (no
        // repository, no table — aggregate-inheritance.md I1).
        if (stance === "unscoped" && !agg.isAbstract) {
          diags.push({
            severity: "error",
            code: "loom.tenancy-stance-unmarked",
            message:
              `aggregate '${agg.name}' declares no tenancy stance; add ` +
              `\`with tenantOwned\` (tenant data) or \`crossTenant\` (shared data).`,
            source: `${ctx.name}/${agg.name}`,
          });
        }

        // Tenant-scope lint (uniqueness-and-indexes.md §5): a `unique (...)`
        // on a tenant-owned aggregate that omits the tenant discriminator
        // (`tenantId`) is a global unique — it blocks legitimate cross-tenant
        // duplicates.  Almost always the author meant `unique (tenantId, …)`.
        if (stance === "tenantOwned") {
          for (const uk of agg.uniqueKeys ?? []) {
            if (!uk.columns.includes("tenantId")) {
              diags.push({
                severity: "warning",
                code: "loom.unique-missing-tenant-scope",
                message:
                  `\`${uk.source}\` on tenant-owned aggregate '${agg.name}' omits the tenant ` +
                  `discriminator — this is a GLOBAL unique across all tenants. Did you mean ` +
                  `\`unique (tenantId, ${uk.columns.join(", ")})\`?`,
                source: `${ctx.name}/${agg.name}`,
              });
            }
          }
        }
      }
    }
  }
}
