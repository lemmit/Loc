import {
  assignStmt,
  contextFilter,
  defineMacro,
  field,
  implementsCapability,
  memberAccess,
  not,
  nullLit,
  operation,
  primType,
  thisRef,
} from "../macro-api/index.js";
import { boolLit, callExpr } from "../macro-api/ui-factories.js";

/** Marks an aggregate as soft-deletable.  Two fields, two
 * operations, a `filter !this.isDeleted` capability that hides
 * soft-deleted rows, and an `implements "softDeletable"` tag so
 * generators group runtime infrastructure (.NET emits one
 * OnModelCreating filter loop scoped by `ISoftDeletable`).  The
 * macro is sugar over hand-written `filter` / `implements` source —
 * a user can write the same aggregate without using the macro. */
export default defineMacro({
  name: "softDeletable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Adds isDeleted/deletedAt fields, softDelete()/restore() operations, " +
    "and a query filter that hides soft-deleted rows from default reads.",
  expand() {
    return [
      field("isDeleted", primType("bool")),
      field("deletedAt", primType("datetime", { optional: true })),
      operation("softDelete", [], [
        assignStmt("isDeleted", boolLit(true)),
        assignStmt("deletedAt", callExpr("now", [])),
      ]),
      operation("restore", [], [
        assignStmt("isDeleted", boolLit(false)),
        assignStmt("deletedAt", nullLit()),
      ]),
      implementsCapability("softDeletable"),
      contextFilter(not(memberAccess(thisRef(), "isDeleted"))),
    ];
  },
});
