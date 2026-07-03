// Tenancy stance classification (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §3).
//
// An aggregate's tenancy *stance* is a pure function of facts already on
// the IR — the `crossTenant` header flag, `tenantOwned` capability
// membership, and the system's `tenancy by … of <Registry>` declaration —
// so it is derived on demand (the `classifyPage` pattern in
// `page-kind.ts`), never stamped onto AggregateIR.

import type { AggregateIR, SystemIR } from "../types/loom-ir.js";

/** The prelude capability that marks an aggregate as tenant-scoped
 *  (`with tenantOwned` — see `src/macros/prelude.ts`). */
export const TENANT_OWNED_CAPABILITY = "tenantOwned";

export type TenantStance = "tenantOwned" | "crossTenant" | "registry" | "unscoped";

/** True when the aggregate implements the `tenantOwned` prelude capability
 *  (via `with`/`implements`, aggregate- or context-scope — the lowered
 *  `capabilities` identity record; never re-derived from member shapes). */
export function hasTenantOwned(agg: Pick<AggregateIR, "capabilities">): boolean {
  return (agg.capabilities ?? []).includes(TENANT_OWNED_CAPABILITY);
}

/** Classify an aggregate's tenancy stance under its system.
 *
 *  Precedence: the registry role wins (the `of`-target is self-keyed —
 *  neither marker fits it; a *marked* registry is a dedicated diagnostic,
 *  `loom.tenancy-registry-marked`), then `tenantOwned`, then `crossTenant`.
 *  An aggregate carrying BOTH markers classifies as `tenantOwned` here —
 *  the contradiction itself is `loom.tenancy-conflicting-stance`, checked
 *  from the raw flags, not a stance. */
export function classifyTenantStance(
  agg: Pick<AggregateIR, "name" | "crossTenant" | "capabilities">,
  sys: Pick<SystemIR, "tenancy">,
): TenantStance {
  if (sys.tenancy && agg.name === sys.tenancy.registryName) return "registry";
  if (hasTenantOwned(agg)) return "tenantOwned";
  if (agg.crossTenant) return "crossTenant";
  return "unscoped";
}
