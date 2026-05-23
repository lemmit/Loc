import {
  contextStamp,
  defineMacro,
  field,
  idRef,
  nameRef,
  primType,
} from "../macro-api/index.js";
import { callExpr } from "../macro-api/ui-factories.js";

/** Stamps createdAt/updatedAt and createdBy/updatedBy on every
 * mutation.  The fields are declared structurally; the stamping
 * behaviour is expressed declaratively via `contextStamp(...)` —
 * a capability that says "on these lifecycle events, assign these
 * field/value pairs."  Backends translate the AST through their
 * own expression renderer into the right hook (.NET:
 * SaveChangesInterceptor with a per-entity-type stamp registry;
 * Drizzle: insert/update middleware; Ecto: changeset).
 *
 * No marker interface is emitted — the runtime's per-entity-type
 * registry indexes by aggregate type directly, so the IAuditable
 * tag isn't needed.  If a project wants C# code to type-check
 * against an interface, that's a project-level extension. */
export default defineMacro({
  name: "auditable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Stamps createdAt/updatedAt/createdBy/updatedBy on every mutation. " +
    "Generators emit one shared stamping hook per application keyed " +
    "by entity type.",
  expand() {
    return [
      field("createdAt", primType("datetime")),
      field("updatedAt", primType("datetime")),
      field("createdBy", idRef("User")),
      field("updatedBy", idRef("User")),
      contextStamp({
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
