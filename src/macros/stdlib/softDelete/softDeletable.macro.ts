import {
  assignStmt,
  defineMacro,
  field,
  implementsCapability,
  nullLit,
  operation,
  primType,
} from "../../api/index.js";
import { boolLit, callExpr } from "../../api/ui-factories.js";

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
 *     isDeleted: bool internal
 *     deletedAt: datetime? managed
 *     operation softDelete() { isDeleted := true; deletedAt := now() }
 *     operation restore()    { isDeleted := false; deletedAt := null }
 *     implements "softDeletable"
 *   }
 *
 * `isDeleted` is `internal` — never exposed via API (the soft-delete
 * filter hides deleted rows from reads anyway, and admin UIs that
 * want to see the flag can still render it from view-side data).
 * `deletedAt` is `managed` — the `softDelete` operation sets it,
 * not the client.  Both modifiers feed `crudish`'s
 * `writableUpdateFields` filter so neither field appears in a
 * generated update operation's parameters.
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
      field("isDeleted", primType("bool"), { access: "internal" }),
      field("deletedAt", primType("datetime", { optional: true }), { access: "managed" }),
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
