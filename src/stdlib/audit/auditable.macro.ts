import {
  defineMacro,
  field,
  idRef,
  implementsCapability,
  primType,
} from "../../macro-api/index.js";

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
 *     createdAt: datetime managed
 *     updatedAt: datetime managed
 *     createdBy: User id managed
 *     updatedBy: User id managed
 *     implements "auditable"
 *   }
 *
 * All four fields carry `access: "managed"` — they're server-owned
 * and must not appear in client-supplied create/update inputs.  This
 * is also what excludes them from `crudish`'s generated `update`
 * operation (the `writableUpdateFields` filter checks both the
 * macro-origin tag AND the access modifier as belt-and-braces).
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
      field("createdAt", primType("datetime"), { access: "managed" }),
      field("updatedAt", primType("datetime"), { access: "managed" }),
      field("createdBy", idRef("User"), { access: "managed" }),
      field("updatedBy", idRef("User"), { access: "managed" }),
      implementsCapability("auditable"),
    ];
  },
});
