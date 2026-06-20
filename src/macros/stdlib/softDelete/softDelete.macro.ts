import { assignStmt, defineMacro, nullLit, operation } from "../../api/index.js";
import { boolLit, nowExpr } from "../../api/ui-factories.js";

/** Soft-delete operations (typed-capabilities.md, Phase 3).
 *
 * Adds the `softDelete()` / `restore()` mutations to an aggregate.  A capability
 * is a pure mixin (fields + filter + stamp), so the operations live here, in a
 * macro, while the STATE + query FILTER come from the built-in `softDeletable`
 * capability.  Compose them:
 *
 *   aggregate Order with softDeletable, softDelete { subject: string }
 *
 *   ↓  softDeletable (capability) → isDeleted, deletedAt, filter !this.isDeleted
 *      softDelete    (macro)      → operation softDelete() / restore()
 *
 * (Pre-Phase-3 this name was the *context* macro that declared the
 * `filter for "softDeletable"` predicate; the capability now co-locates that
 * filter, so `softDelete` is repurposed as the aggregate-level ops macro.) */
export default defineMacro({
  name: "softDelete",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Adds softDelete()/restore() operations to an aggregate.  Pair with the " +
    "built-in `softDeletable` capability, which supplies the isDeleted/deletedAt " +
    "state and the read filter.",
  expand() {
    return [
      operation(
        "softDelete",
        [],
        [assignStmt("isDeleted", boolLit(true)), assignStmt("deletedAt", nowExpr())],
      ),
      operation(
        "restore",
        [],
        [assignStmt("isDeleted", boolLit(false)), assignStmt("deletedAt", nullLit())],
      ),
    ];
  },
});
