import { defineMacro, field, idRef, implementsCapability, primType } from "../../macro-api/index.js";

/** Aggregate-level state for the audit capability.
 *
 * Adds the four canonical audit fields (createdAt, updatedAt,
 * createdBy, updatedBy) and opts the aggregate into the `auditable`
 * capability group via `implements`.  This macro carries **no
 * stamping rules** — the per-event field assignments are the
 * capability's responsibility; declare them via `with audit` on the
 * enclosing context (or hand-write `stamp for "auditable" onCreate
 * { ... }` there).
 *
 * Source-equivalent:
 *
 *   aggregate Order with auditable {
 *     subject: string
 *   }
 *
 *   ↓
 *
 *   aggregate Order {
 *     subject: string
 *     createdAt: datetime
 *     updatedAt: datetime
 *     createdBy: Id<User>
 *     updatedBy: Id<User>
 *     implements "auditable"
 *   }
 *
 * Compose with `audit` at context level for the runtime stamping,
 * or use `auditedByDefault` to apply both in one go. */
export default defineMacro({
  name: "auditable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Adds audit fields (createdAt/updatedAt/createdBy/updatedBy) and opts " +
    "the aggregate into the `auditable` capability group.  The stamping " +
    "behavior comes from a sibling context-level `audit` macro or " +
    'hand-written `stamp for "auditable" ...`.',
  expand() {
    return [
      field("createdAt", primType("datetime")),
      field("updatedAt", primType("datetime")),
      field("createdBy", idRef("User")),
      field("updatedBy", idRef("User")),
      implementsCapability("auditable"),
    ];
  },
});
