// Tenancy stance classification (multi-tenancy Phase 1a, slice 1a.3 —
// docs/old/plans/multi-tenancy-implementation.md §3).
//
// An aggregate's tenancy *stance* is a pure function of facts already on
// the IR — the `crossTenant` header flag, `tenantOwned` capability
// membership, and the system's `tenancy by … of <Registry>` declaration —
// so it is derived on demand (the `classifyPage` pattern in
// `page-kind.ts`), never stamped onto AggregateIR.

import type {
  AggregateIR,
  AuthzFilterKind,
  ExprIR,
  IdValueType,
  SystemIR,
  TypeIR,
} from "../types/loom-ir.js";

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

/** The field name the `tenantOwned` capability provides for the materialized
 *  DataKey path (multi-tenancy Phase 2, plan P2.3 —
 *  `docs/old/plans/multi-tenancy-phase2.md`).  Unlike the `tenantRegistry`
 *  capability's own `dataKey` (a managed field that stays ON the wire — the
 *  registry's path is meant to be readable), `tenantOwned`'s `dataKey` is a
 *  **persistence-only column**: `authorization.md §2` calls for it "kept out
 *  of `wireShape`" entirely, never just access-gated.  `enrichLoomModel`
 *  (`wireFieldsForAggregate`) drops any field with this name on an aggregate
 *  where {@link hasTenantOwned} holds — the registry's own same-named field is
 *  unaffected since a `tenantOwned` aggregate and the registry are disjoint
 *  (`classifyTenantStance`). */
export const TENANT_OWNED_DATA_KEY_FIELD = "dataKey";

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
 *   - `"same"`   — claim type equals the id's value type (a guid id +
 *                  `tenantId: guid`, `ids string` + `tenantId: string`, …);
 *                  every backend compares directly.
 *   - `"guid-from-string"` — a guid id + a `string` claim (the common JWT
 *                  shape).  Each backend PARSES the claim to the id's value
 *                  type at the accessor site, yielding its null for a claim
 *                  that doesn't parse, so a malformed one reads empty rather
 *                  than 500-ing — see {@link guidFromStringSelfScope}.
 *   - `"mismatch"` — anything else (e.g. a guid id + `tenantId: int`).
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

/** The claim member name when `e` is the `"guid-from-string"` registry
 *  self-scope comparison — `this.id == currentUser.<claim>` where the id's
 *  value type is `guid` and the claim is declared `string` (see
 *  {@link tenancyClaimBinding}).  `undefined` for every other shape.
 *
 *  This is the ONE comparison in the language whose principal side can FAIL TO
 *  PARSE at the accessor site: an authenticated token carrying `tenantId:
 *  "not-a-guid"` is an ordinary unauthorized read, but a bare parse throws
 *  (`IllegalArgumentException` / `Ecto.Query.CastError` / pg `invalid input
 *  syntax for type uuid`) and answers it with a 500.  Each backend gates its
 *  parse-to-NULL rendering on this predicate so a malformed claim degrades to
 *  the same empty result a foreign-but-well-formed one already gives — .NET's
 *  `Guid.TryParse(…) ? new <Agg>Id(g) : null` is the reference shape
 *  (M-T3.7(c)).
 *
 *  `idOnLeft` reports which operand carried `this.id`, so a backend that emits
 *  an infix comparison keeps the authored operand order. */
export function guidFromStringSelfScope(
  e: ExprIR,
): { claim: string; idOnLeft: boolean } | undefined {
  if (e.kind === "paren") return guidFromStringSelfScope(e.inner);
  if (e.kind !== "binary" || e.op !== "==") return undefined;
  const idOnLeft = isGuidSelfId(e.left);
  if (!idOnLeft && !isGuidSelfId(e.right)) return undefined;
  const claim = stringPrincipalClaim(idOnLeft ? e.right : e.left);
  return claim === undefined ? undefined : { claim, idOnLeft };
}

/** The tenancy claim field name when the SYSTEM's binding is
 *  `"guid-from-string"` — a `guid`-id registry keyed by a `string` claim (see
 *  {@link tenancyClaimBinding}) — else `undefined`.  The system-level twin of
 *  {@link guidFromStringSelfScope}: that one answers "does THIS comparison need
 *  the parse-to-null guard", this one answers "does this system need the
 *  accessor that performs it", which is what an auth-surface emitter asks
 *  before emitting one (M-T3.7(c)). */
export function guidFromStringTenancyClaim(
  sys: Pick<SystemIR, "tenancy" | "subdomains" | "user">,
): string | undefined {
  const claimField = sys.tenancy?.claimField;
  if (!claimField) return undefined;
  const registry = findAggregate(sys, sys.tenancy!.registryName);
  if (!registry) return undefined;
  const declared = sys.user?.fields.find((f) => f.name === claimField)?.type;
  const claimType = declared?.kind === "optional" ? declared.inner : declared;
  return tenancyClaimBinding(registry.idValueType, claimType) === "guid-from-string"
    ? claimField
    : undefined;
}

function findAggregate(sys: Pick<SystemIR, "subdomains">, name: string): AggregateIR | undefined {
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      for (const agg of ctx.aggregates) {
        if (agg.name === name) return agg;
      }
    }
  }
  return undefined;
}

/** The `User` accessor name that yields {@link guidFromStringTenancyClaim}'s
 *  claim parsed to the registry's `guid` id type, or null when it is absent or
 *  MALFORMED — the fail-closed coercion every backend's registry self-scope
 *  binds through (M-T3.7(c)).  Derived from the claim name so it can't collide
 *  with the claim's own accessor. */
export function guidClaimAccessorName(claimField: string): string {
  return `${claimField}AsUuid`;
}

/** `this.id` typed as the aggregate's own `guid`-valued id. */
function isGuidSelfId(x: ExprIR): boolean {
  if (x.kind === "paren") return isGuidSelfId(x.inner);
  return (
    x.kind === "member" &&
    x.receiver.kind === "this" &&
    x.member === "id" &&
    x.memberType.kind === "id" &&
    x.memberType.valueType === "guid"
  );
}

/** `currentUser.<claim>` whose DECLARED type is `string` — the side that can
 *  hold a value the id's `guid` type cannot represent. */
function stringPrincipalClaim(x: ExprIR): string | undefined {
  if (x.kind === "paren") return stringPrincipalClaim(x.inner);
  if (
    x.kind === "member" &&
    x.receiver.kind === "ref" &&
    x.receiver.refKind === "current-user" &&
    x.memberType.kind === "primitive" &&
    x.memberType.name === "string"
  ) {
    return x.member;
  }
  return undefined;
}

/** The tenant-discriminator COLUMN the `tenantOwned` capability provides
 *  (`src/macros/prelude.ts`) — the flat tenant floor's LHS.
 *
 *  This is a ROW column name, owned by the capability and not the author's to
 *  choose, so it is a constant.  It is deliberately NOT the principal-side
 *  name: the claim the row is compared against is whatever `tenancy by
 *  user.<claim>` declared, which is a per-system fact and travels as an
 *  argument (see {@link buildTenantFloorFilter}).  The two coincide in every
 *  fixture that declares the claim as `tenantId`, which is exactly how they
 *  stayed conflated — see `tenancy-claim-name.ddd`. */
export const TENANT_OWNED_TENANT_ID_FIELD = "tenantId";

/** The derived principal member that carries the caller's materialized org
 *  path (multi-tenancy Phase 2 P2.1 — `currentUser.orgPath`). */
export const ORG_PATH_CLAIM_FIELD = "orgPath";

/** The derived principal member that carries the caller's ROOT-org segment
 *  (multi-tenancy Phase 2 P2.5 — `currentUser.rootOrg`): the first segment of
 *  `orgPath` (everything before the first {@link DATA_KEY_PATH_DELIMITER}, or
 *  the whole path when it has none).  A pure string computation off the
 *  already-resolved `orgPath` — no DB read.  It anchors the `global` read
 *  level's root-subtree widening (P2.5): under flat tenancy `orgPath` is the
 *  root-segment claim itself, so `rootOrg == orgPath` and `global == deep ==
 *  local` all coincide at the tenant floor. */
export const ROOT_ORG_CLAIM_FIELD = "rootOrg";

/** The materialized-path segment delimiter (`root.child.leaf`).  The `deep`
 *  read level prefix-matches on it so `org_a` does NOT match `org_ab` — a
 *  descendant is `path` exactly or `path` + delimiter + more.  (Full
 *  delimiter/opclass index discipline is P2.5; the delimiter-correct prefix
 *  itself is emitted here.) */
export const DATA_KEY_PATH_DELIMITER = ".";

/**
 * Semantics every backend renders the `scope` authorization filter (M-T9.9) to
 * (row R, principal P; fail-closed — no principal ⇒ matches nothing):
 *
 *   (R.dataKey IS NOT NULL
 *      AND (R.dataKey = P.orgPath                       -- the caller's own node
 *           OR R.dataKey LIKE P.orgPath || '.%'))       -- + all descendants
 *   OR (R.dataKey IS NULL                               -- legacy / principal-less
 *       AND R.tenantId = P.tenantId)                    --   rows degrade to `local`
 *
 * The NULL branch is the deliberate OR-fallback (not pure fail-closed LIKE):
 * every row stamped before P2.3 (or by a principal-less workflow save) carries
 * a NULL `data_key`, which a bare prefix LIKE would silently hide.  Falling
 * those rows back to the flat `tenantId ==` floor keeps them visible to their
 * own tenant (never widening past it — no cross-tenant leak) and degrades
 * `deep` to exactly `local` for them, preserving flat-tenancy correctness.
 */
export const DEEP_SCOPE_SEMANTICS = "descendant-or-self path prefix; NULL-dataKey ⇒ tenant floor";

/** Build a subtree reachability predicate for a tenant-owned aggregate as an
 *  `authz-filter` sentinel node carrying a `scope` decision anchored at
 *  `anchorClaim` (M-T9.9).  The `scope` decision carries the two principal
 *  claims (`currentUser.<anchorClaim>`, `currentUser.tenantId`) as
 *  fully-resolved `member` nodes so `exprUsesCurrentUser` classifies the filter
 *  as principal-referencing (routing it to each backend's ambient-principal
 *  query path), and each backend reads the anchor claim field name off
 *  `anchorClaim` (see {@link deepScopeAnchorClaim}).  The row columns
 *  (`dataKey`, `tenantId`) are fixed by the `tenantOwned` capability.  `deep`
 *  anchors at {@link ORG_PATH_CLAIM_FIELD} (the caller's own node +
 *  descendants); `global` anchors at {@link ROOT_ORG_CLAIM_FIELD} (the caller's
 *  ROOT node + descendants — the whole root subtree). */
function buildScopeFilter(
  agg: Pick<AggregateIR, "name">,
  anchorClaim: string,
  tenantClaim: string,
): ExprIR {
  const userShape: TypeIR = { kind: "entity", name: "__User__" };
  const claim = (member: string): ExprIR => ({
    kind: "member",
    receiver: { kind: "ref", name: "currentUser", refKind: "current-user", type: userShape },
    member,
    receiverType: userShape,
    memberType: { kind: "primitive", name: "string" },
  });
  return {
    kind: "authz-filter",
    aggregate: agg.name,
    filter: {
      kind: "scope",
      anchorClaim: claim(anchorClaim),
      tenantClaim: claim(tenantClaim),
    },
  };
}

/** The `scope` decision of an `authz-filter` sentinel, or `undefined` when `e`
 *  is not one.  Thin narrower shared by the render/inspection helpers below. */
function scopeOf(e: ExprIR): Extract<AuthzFilterKind, { kind: "scope" }> | undefined {
  return e.kind === "authz-filter" && e.filter.kind === "scope" ? e.filter : undefined;
}

/** The `deep` read-level reachability predicate — the descendant-or-self
 *  materialized-path scope anchored at `currentUser.orgPath` (P2.4).
 *  `tenantClaim` is the system's declared tenancy claim, used by the
 *  NULL-`dataKey` fallback branch that degrades to the flat tenant floor. */
export function buildDeepScopeFilter(agg: Pick<AggregateIR, "name">, tenantClaim: string): ExprIR {
  return buildScopeFilter(agg, ORG_PATH_CLAIM_FIELD, tenantClaim);
}

/** The flat tenant FLOOR predicate `this.tenantId == currentUser.<claim>` —
 *  the exact ExprIR shape the `tenantOwned` prelude capability filter lowers to
 *  (`src/macros/prelude.ts`), rebuilt here so the `local` WRITE level
 *  (authorization Phase 3 P3.1) can restore the floor at a mutation's command
 *  load even when the READ filter has been widened to `deep`/`global` in
 *  enrichment.  Every backend already renders this shape (it is today's tenant
 *  floor), so the write guard needs no new render code.
 *
 *  The two sides are NOT the same name: the left is the capability's row
 *  COLUMN ({@link TENANT_OWNED_TENANT_ID_FIELD}), the right is the system's
 *  declared `tenancy by user.<claim>` CLAIM.  `tenantClaim` is required rather
 *  than defaulted — a default is precisely how the principal side stayed
 *  pinned to `tenantId` on every backend. */
export function buildTenantFloorFilter(
  agg: Pick<AggregateIR, "name">,
  tenantClaim: string,
): ExprIR {
  const userShape: TypeIR = { kind: "entity", name: "__User__" };
  const stringType: TypeIR = { kind: "primitive", name: "string" };
  return {
    kind: "binary",
    op: "==",
    left: {
      kind: "member",
      receiver: { kind: "this" },
      member: TENANT_OWNED_TENANT_ID_FIELD,
      receiverType: { kind: "entity", name: agg.name },
      memberType: stringType,
    },
    right: {
      kind: "member",
      receiver: { kind: "ref", name: "currentUser", refKind: "current-user", type: userShape },
      member: tenantClaim,
      receiverType: userShape,
      memberType: stringType,
    },
    leftType: stringType,
    resultType: { kind: "primitive", name: "bool" },
  };
}

/** The `global` read-level reachability predicate — the ROOT-org-subtree scope
 *  (multi-tenancy Phase 2 P2.5).  Structurally identical to `deep` but anchored
 *  at `currentUser.rootOrg` (the first `orgPath` segment) instead of `orgPath`,
 *  so it widens from the caller's own node to the caller's ENTIRE root subtree.
 *  Only emitted under a hierarchy registry; under flat tenancy `rootOrg ==
 *  orgPath == the tenant floor` so the levels coincide.  `tenantClaim` is the
 *  system's declared tenancy claim (see {@link buildDeepScopeFilter}). */
export function buildGlobalScopeFilter(
  agg: Pick<AggregateIR, "name">,
  tenantClaim: string,
): ExprIR {
  return buildScopeFilter(agg, ROOT_ORG_CLAIM_FIELD, tenantClaim);
}

/** True when `e` is a subtree read-level sentinel (an `authz-filter` node
 *  carrying a `scope` decision — used by both `deep` and `global`).  Each
 *  backend's query-filter translator gates its native compound rendering on
 *  this. */
export function isDeepScopeFilter(e: ExprIR): boolean {
  return scopeOf(e) !== undefined;
}

/** The DENY carve-out predicate (authorization Phase 4 — deny-wins).  An
 *  `authz-filter` sentinel carrying a `deny` decision (no `currentUser`, so
 *  `exprUsesCurrentUser` is false → each backend routes it to its STATIC filter
 *  path, adding no principal parameter — this is what keeps a denied
 *  aggregate's read/write seam free of the unused-param trap).  Appended to a
 *  denied aggregate's read `contextFilters` (deny read) or set as its
 *  `writeScopeFilter` (deny write) in enrichment; every backend's filter
 *  translator special-cases {@link isDenyFilter} to its native always-false
 *  fragment (Drizzle contradiction / EF `false` / JPQL `1 = 0` /
 *  `cb.disjunction()` / SQLAlchemy contradiction / Ecto `fragment("false")`).
 *  A bare `literal: bool` node is deliberately NOT used — it is not a valid
 *  standalone predicate in Drizzle/Ecto/SQLAlchemy, which is why deny is a
 *  discriminated sentinel, exactly like the deep-scope one. */
export function buildDenyFilter(agg: Pick<AggregateIR, "name">): ExprIR {
  return {
    kind: "authz-filter",
    aggregate: agg.name,
    filter: { kind: "deny" },
  };
}

/** True when `e` is the DENY carve-out sentinel (authorization Phase 4).  Each
 *  backend's filter translator gates its always-false fragment on this. */
export function isDenyFilter(e: ExprIR): boolean {
  return e.kind === "authz-filter" && e.filter.kind === "deny";
}

/** The anchor principal-claim field a subtree sentinel prefix-matches on —
 *  read off the `scope` decision's `anchorClaim` member name (`orgPath` for
 *  `deep`, `rootOrg` for `global`).  Each backend renders
 *  `currentUser.<anchorClaim>` as the LIKE prefix.  Falls back to
 *  {@link ORG_PATH_CLAIM_FIELD} for a hand-built sentinel whose anchor isn't a
 *  `member` (defensive; the builders always emit one). */
export function deepScopeAnchorClaim(e: ExprIR): string {
  const anchor = scopeOf(e)?.anchorClaim;
  if (anchor?.kind === "member") return anchor.member;
  return ORG_PATH_CLAIM_FIELD;
}

/** The TENANT principal-claim field a subtree sentinel's NULL-`dataKey`
 *  fallback branch compares against — read off the `scope` decision's
 *  `tenantClaim` member name, which enrichment binds to the system's declared
 *  `tenancy by user.<claim>`.  The twin of {@link deepScopeAnchorClaim}, and
 *  the reason the five backends must not reach for
 *  {@link TENANT_OWNED_TENANT_ID_FIELD} on the principal side: that constant is
 *  the ROW column, and the two names only coincide when the claim happens to
 *  be called `tenantId`.  Falls back to the constant for a hand-built sentinel
 *  whose `tenantClaim` isn't a `member` (defensive; the builders always emit
 *  one). */
export function deepScopeTenantClaim(e: ExprIR): string {
  const tenant = scopeOf(e)?.tenantClaim;
  if (tenant?.kind === "member") return tenant.member;
  return TENANT_OWNED_TENANT_ID_FIELD;
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
