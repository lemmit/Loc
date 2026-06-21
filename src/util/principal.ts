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
