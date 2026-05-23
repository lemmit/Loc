import {
  assignStmt,
  contextFilter,
  defineMacro,
  field,
  memberAccess,
  not,
  nullLit,
  operation,
  primType,
  thisRef,
} from "../macro-api/index.js";
import { boolLit, callExpr } from "../macro-api/ui-factories.js";

/** Marks an aggregate as soft-deletable.  Two fields, two
 * operations, and a `contextFilter` capability that hides
 * soft-deleted rows from default reads.
 *
 * The filter predicate is built as a Loom expression
 * (`!this.isDeleted`); backends translate via their normal
 * expression renderer (.NET: `HasQueryFilter`; Drizzle: query
 * wrapper; Ecto: base query).  The compiler does not know what
 * "soft delete" means — it just sees a filter predicate. */
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
      contextFilter(not(memberAccess(thisRef(), "isDeleted"))),
    ];
  },
});
