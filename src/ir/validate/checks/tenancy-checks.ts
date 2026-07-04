import type { SystemIR, TypeIR } from "../../types/loom-ir.js";
import {
  classifyTenantStance,
  hasTenantOwned,
  tenancyClaimBinding,
} from "../../util/tenant-stance.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Tenancy checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §1).
//
// The AST-level tenancy rule (duplicate `tenancy by`) lives in
// `src/language/validators/tenancy.ts`; claim / registry existence is the
// LINKER's job since 1b.1 (both bindings are real cross-references — an
// unknown name is a parse-level "Could not resolve reference …", not the
// former `loom.tenancy-registry-unknown` / `loom.tenancy-unknown-claim`).
// This leaf owns everything that needs the merged, fully-lowered model:
//
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

/** Display name for the claim's declared type in the mismatch message. */
function typeName(t: TypeIR): string {
  return t.kind === "primitive" ? t.name : t.kind;
}

export function validateTenancy(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const tenancy = sys.tenancy;

  // Registry existence is a LINKING concern since 1b.1 — `of <Registry>` is a
  // real cross-reference (`registry=[Aggregate:ID]`), so an unknown name
  // surfaces as a Langium "could not resolve" diagnostic at parse time; no IR
  // re-check needed (an unresolved ref lowers with its `$refText`, and the
  // lookups below simply find no aggregate and skip).
  if (tenancy) {
    // The derived registry self-scope filter (Phase 1b, capstone decision 4)
    // compares `<Registry>.id == currentUser.<claim>` — the `tenantId ≡
    // <Registry>.id` identity — so the claim's declared type must bind
    // against the registry's id value type: same-typed always works, and a
    // `string` claim binds as a guid at each backend's accessor site
    // (`tenancyClaimBinding`).  Anything else can't compare on any backend —
    // reject with the fix spelled out rather than emitting a filter that
    // never matches (or doesn't compile).
    const registry = sys.subdomains
      .flatMap((mod) => mod.contexts)
      .flatMap((ctx) => ctx.aggregates)
      .find((a) => a.name === tenancy.registryName);
    const claimType = sys.user?.fields.find((f) => f.name === tenancy.claimField)?.type;
    if (
      registry &&
      claimType &&
      tenancyClaimBinding(registry.idValueType, claimType) === "mismatch"
    ) {
      diags.push({
        severity: "error",
        code: "loom.tenancy-claim-type-mismatch",
        message:
          `system '${sys.name}': tenancy claim 'user.${tenancy.claimField}' is typed ` +
          `'${typeName(claimType)}' but registry '${registry.name}' has 'ids ${registry.idValueType}'. ` +
          `The derived registry self-scope filter compares ${registry.name}.id to the claim, so ` +
          `declare the claim as '${tenancy.claimField}: ${registry.idValueType}'` +
          `${registry.idValueType === "guid" ? ` (or '${tenancy.claimField}: string', bound as a guid at the accessor site)` : ""}, ` +
          `or change the registry's 'ids'.`,
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
