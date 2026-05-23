import {
  contextStamp,
  defineMacro,
  field,
  idRef,
  implementsCapability,
  nameRef,
  primType,
} from "../macro-api/index.js";
import { callExpr } from "../macro-api/ui-factories.js";

/** Stamps createdAt/updatedAt/createdBy/updatedBy on every mutation.
 * The fields are declared structurally; the stamping behaviour is
 * declared via `stamp onCreate { ... }` / `stamp onUpdate { ... }`
 * — pure sugar over what the user could hand-write inside the
 * aggregate.  Backends translate the stamping AST via their per-
 * entity stamping path (.NET: SaveChangesInterceptor scoped by
 * `IAuditable`; Drizzle: insert/update middleware; Ecto: changeset).
 *
 * `implements "auditable"` opts the aggregate into the auditable
 * capability group; .NET emits a marker `IAuditable` interface and
 * one OnModelCreating loop scoped by it, grouping all auditable
 * aggregates into one infrastructure block. */
export default defineMacro({
  name: "auditable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Stamps createdAt/updatedAt/createdBy/updatedBy on every mutation, " +
    "and opts the aggregate into the `auditable` capability group so " +
    "generators emit one shared stamping hook per application.",
  expand() {
    return [
      field("createdAt", primType("datetime")),
      field("updatedAt", primType("datetime")),
      field("createdBy", idRef("User")),
      field("updatedBy", idRef("User")),
      implementsCapability("auditable"),
      ...contextStamp({
        onCreate: [
          { field: "createdAt", value: callExpr("now", []) },
          { field: "createdBy", value: nameRef("currentUser") },
        ],
        onUpdate: [
          { field: "updatedAt", value: callExpr("now", []) },
          { field: "updatedBy", value: nameRef("currentUser") },
        ],
      }),
    ];
  },
});
