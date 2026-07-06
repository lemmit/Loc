// Tenancy stance classification (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §3).
//
// An aggregate's tenancy *stance* is a pure function of facts already on
// the IR — the `crossTenant` header flag, `tenantOwned` capability
// membership, and the system's `tenancy by … of <Registry>` declaration —
// so it is derived on demand (the `classifyPage` pattern in
// `page-kind.ts`), never stamped onto AggregateIR.

import type { AggregateIR, ExprIR, IdValueType, SystemIR, TypeIR } from "../types/loom-ir.js";

/** The prelude capability that marks an aggregate as tenant-scoped
 *  (`with tenantOwned` — see `src/macros/prelude.ts`). */
export const TENANT_OWNED_CAPABILITY = "tenantOwned";

/** The prelude capability that opts the tenant registry into hierarchy
 *  (`implements tenantRegistry` — multi-tenancy Phase 2, plan P2.2).  It
 *  PROVIDES the registry tree fields `parent: Self id?` (immutable self-FK,
 *  null = root) and the managed `dataKey` materialized path.  Only the
 *  registry (the `of <Registry>` target) may carry it, and its presence is
 *  what turns `currentUser.orgPath` from the claim-copy fallback into a real
 *  registry `dataKey` lookup.  See `src/macros/prelude.ts`. */
export const TENANT_REGISTRY_CAPABILITY = "tenantRegistry";

/** `contextFilterOrigins` marker for the DERIVED registry self-scope filter
 *  (multi-tenancy Phase 1b, capstone decision 4): under `tenancy by
 *  user.<claim> of <Registry>`, enrichment appends `this.id ==
 *  currentUser.<claim>` to the registry's `contextFilters` — the
 *  `tenantId ≡ <Registry>.id` identity, never written by the author.  The
 *  origin marks provenance (and makes the enrichment pass idempotent); it is
 *  NOT a capability name, so a named `ignoring tenancy` clause is rejected by
 *  `loom.filter-bypass-unknown-capability` (only `ignoring *` — the
 *  deliberate, authored escape hatch that already drops `tenantOwned`'s
 *  filter — bypasses it). */
export const TENANCY_SELF_SCOPE_ORIGIN = "tenancy";

/** How the tenancy claim binds against the registry's id in the derived
 *  self-scope comparison (`this.id == currentUser.<claim>`):
 *
 *   - `"same"`   — claim type equals the id's value type (`ids guid` +
 *                  `tenantId: guid`, `ids string` + `tenantId: string`, …);
 *                  every backend compares directly.
 *   - `"guid-from-string"` — `ids guid` + a `string` claim (the common JWT
 *                  shape).  Each backend binds the claim as the id's value
 *                  type at the accessor site (pg casts the text param on
 *                  node/elixir/python; .NET wraps in `Guid.Parse`; Java
 *                  converts in the SpEL principal accessor).
 *   - `"mismatch"` — anything else (e.g. `ids guid` + `tenantId: int`).
 *                  Enrichment derives NO filter and IR validation rejects it
 *                  (`loom.tenancy-claim-type-mismatch`). */
export type TenancyClaimBinding = "same" | "guid-from-string" | "mismatch";

export function tenancyClaimBinding(
  idValueType: IdValueType,
  claimType: TypeIR | undefined,
): TenancyClaimBinding {
  if (claimType?.kind !== "primitive") return "mismatch";
  if (claimType.name === idValueType) return "same";
  if (idValueType === "guid" && claimType.name === "string") return "guid-from-string";
  return "mismatch";
}

/** Build the derived registry self-scope predicate `this.id ==
 *  currentUser.<claim>` as fully-resolved ExprIR — the exact shapes the
 *  `tenantOwned` prelude filter lowers to (`member` over `this` /
 *  `current-user` ref against the `__User__` principal shape), so every
 *  backend's existing principal-capability-filter path renders it without
 *  re-resolving.  Types are truthful: the left side is the registry's id
 *  type, the right side the claim's DECLARED type — a `guid`-vs-`string`
 *  comparison is bound per backend at the accessor site (see
 *  {@link tenancyClaimBinding}). */
export function buildRegistrySelfScopeFilter(
  registry: Pick<AggregateIR, "name" | "idValueType">,
  claimField: string,
  claimType: TypeIR,
): ExprIR {
  const idType: TypeIR = {
    kind: "id",
    targetName: registry.name,
    valueType: registry.idValueType,
  };
  // Mirrors `USER_SHAPE_NAME` in `src/ir/lower/lower-types.ts` (the
  // synthetic principal entity every lowered `currentUser` ref carries).
  const userShape: TypeIR = { kind: "entity", name: "__User__" };
  return {
    kind: "binary",
    op: "==",
    left: {
      kind: "member",
      receiver: { kind: "this" },
      member: "id",
      receiverType: { kind: "entity", name: registry.name },
      memberType: idType,
    },
    right: {
      kind: "member",
      receiver: { kind: "ref", name: "currentUser", refKind: "current-user", type: userShape },
      member: claimField,
      receiverType: userShape,
      memberType: claimType,
    },
    leftType: idType,
    resultType: { kind: "primitive", name: "bool" },
  };
}

export type TenantStance = "tenantOwned" | "crossTenant" | "registry" | "unscoped";

/** True when the aggregate implements the `tenantOwned` prelude capability
 *  (via `with`/`implements`, aggregate- or context-scope — the lowered
 *  `capabilities` identity record; never re-derived from member shapes). */
export function hasTenantOwned(agg: Pick<AggregateIR, "capabilities">): boolean {
  return (agg.capabilities ?? []).includes(TENANT_OWNED_CAPABILITY);
}

/** True when the aggregate carries the `tenantRegistry` prelude capability —
 *  i.e. it opted into hierarchy and therefore has a `dataKey` column
 *  (multi-tenancy Phase 2, plan P2.2).  Drives both the structural checks
 *  (exactly one, on the `of` target) and the `currentUser.orgPath` accessor
 *  swap (registry `dataKey` read only when hierarchy is enabled). */
export function hasTenantRegistry(agg: Pick<AggregateIR, "capabilities">): boolean {
  return (agg.capabilities ?? []).includes(TENANT_REGISTRY_CAPABILITY);
}

/** The system's tenant-registry aggregate when it has opted into hierarchy —
 *  the `of <Registry>` target that also carries `implements tenantRegistry`
 *  (so it has a `dataKey` column).  `undefined` for a flat system (no
 *  `tenancy by`, or a registry without the capability).  The single signal the
 *  per-backend `currentUser.orgPath` emitters read to decide between the P2.1
 *  claim-copy fallback and the real registry `dataKey` lookup. */
export function hierarchyRegistry(
  sys: Pick<SystemIR, "tenancy" | "subdomains">,
): AggregateIR | undefined {
  if (!sys.tenancy) return undefined;
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      for (const agg of ctx.aggregates) {
        if (agg.name === sys.tenancy.registryName && hasTenantRegistry(agg)) return agg;
      }
    }
  }
  return undefined;
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
