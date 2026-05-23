import {
  assignStmt,
  defineMacro,
  field,
  implementsCapability,
  nullLit,
  operation,
  primType,
} from "../macro-api/index.js";
import { boolLit, callExpr } from "../macro-api/ui-factories.js";

/** Aggregate-level state for the soft-delete capability.
 *
 * Adds the storage (`isDeleted`, `deletedAt`), the mutations
 * (`softDelete()`, `restore()`), and opts the aggregate into the
 * `softDeletable` capability group via `implements`.  This macro
 * carries **no filter** — the predicate that hides soft-deleted
 * rows is the capability's responsibility, not the aggregate's;
 * declare it via `with softDelete` on the enclosing context (or
 * hand-write `filter for "softDeletable" !this.isDeleted` there).
 *
 * Source-equivalent:
 *
 *   aggregate Order with softDeletable {
 *     subject: string
 *   }
 *
 *   ↓
 *
 *   aggregate Order {
 *     subject: string
 *     isDeleted: bool
 *     deletedAt: datetime?
 *     operation softDelete() { isDeleted := true; deletedAt := now() }
 *     operation restore()    { isDeleted := false; deletedAt := null }
 *     implements "softDeletable"
 *   }
 *
 * Compose with `softDelete` at context level for the runtime filter,
 * or use `softDeleteByDefault` to apply both in one go. */
export default defineMacro({
  name: "softDeletable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Adds soft-delete state (fields + operations) to an aggregate and " +
    "opts it into the `softDeletable` capability group.  The filter " +
    "predicate comes from a sibling context-level `softDelete` macro " +
    'or hand-written `filter for "softDeletable" ...`.',
  expand() {
    return [
      field("isDeleted", primType("bool")),
      field("deletedAt", primType("datetime", { optional: true })),
      operation(
        "softDelete",
        [],
        [assignStmt("isDeleted", boolLit(true)), assignStmt("deletedAt", callExpr("now", []))],
      ),
      operation(
        "restore",
        [],
        [assignStmt("isDeleted", boolLit(false)), assignStmt("deletedAt", nullLit())],
      ),
      implementsCapability("softDeletable"),
    ];
  },
});
