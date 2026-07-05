// The authentication principal — the `user { ... }` block's identity.
//
// The principal is NOT a domain aggregate: it has no `aggregate User { }`
// declaration, so no `UserId` strong-id class is ever emitted and its id is
// whatever scalar the `user { id: <type> }` block declares.  Every generator
// names the projected principal record `User` (see the dotnet/java auth emits),
// and the built-in `auditable` capability references the principal id as
// `User id` — both go through this single name so a reference to the principal
// stays distinguishable from a (hypothetical) domain aggregate of the same name.
export const PRINCIPAL_TYPE_NAME = "User";

/** The derived principal member `currentUser.orgPath` — the materialized
 *  DataKey path of the caller's tenant, resolved per-request and memoized on
 *  the request-scoped principal (multi-tenancy Phase 2, plan P2.1).  Unlike
 *  the `user { … }` claims it is NOT an IdP token field: the `claims:` map is
 *  a static token→field projection with no derived-value carrier, so `orgPath`
 *  is *computed* server-side from the tenancy claim we already hold.  It is
 *  therefore only meaningful under a `tenancy by user.<claim> of <Registry>`
 *  declaration; referencing it without one is a hard error
 *  (`loom.orgpath-without-tenancy`, fail-closed).
 *
 *  P2.1 resolves it to the tenant claim's value (the root-segment path — the
 *  defined fallback while the registry carries no `dataKey` column yet, P2.2);
 *  every backend's principal exposes it via a computed accessor whose body is
 *  that fallback, so P2.2 swaps only the accessor body (`SELECT dataKey FROM
 *  <registry> WHERE id = <claim>`), never the call sites. */
export const PRINCIPAL_ORG_PATH = "orgPath";

/** The derived principal member `currentUser.rootOrg` — the caller's ROOT-org
 *  segment (multi-tenancy Phase 2, plan P2.5): the first segment of
 *  {@link PRINCIPAL_ORG_PATH} (the substring before the first `.`, or the whole
 *  path when it has no `.`).  A pure string computation off the already-resolved
 *  `orgPath` — NO extra DB read; every backend derives it from its `orgPath`
 *  accessor.  Like `orgPath` it is meaningful only under a `tenancy by` line
 *  (`loom.orgpath-without-tenancy`, fail-closed).  It anchors the `global` read
 *  level's root-subtree widening; under flat tenancy `orgPath` is the
 *  root-segment claim, so `rootOrg == orgPath`. */
export const PRINCIPAL_ROOT_ORG = "rootOrg";

/** The principal's id field — the field named `id`, else the first declared
 *  field of the `user { ... }` block.  A `currentUser` stamp / filter value
 *  resolves to `currentUser.<thisField>` (the principal id), mirroring the
 *  Java backend's `currentUser.id()`.  `null` when no `user {}` block (no
 *  principal at all).  Mirrors the dotnet `actorIdField` derivation. */
export function principalIdField(
  user: { fields: readonly { name: string }[] } | undefined,
): string | null {
  if (!user) return null;
  const field = user.fields.find((f) => f.name === "id") ?? user.fields[0];
  return field ? field.name : null;
}
