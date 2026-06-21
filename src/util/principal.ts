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
