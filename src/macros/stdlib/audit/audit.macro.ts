import { contextStamp, defineMacro, nameRef } from "../../api/index.js";
import { nowExpr } from "../../api/ui-factories.js";

/** Context-level companion to `auditable`.
 *
 * Declares the audit stamping rules (createdAt / createdBy on create;
 * updatedAt / updatedBy on update) once at the context level, scoped
 * to the `auditable` capability.  Aggregates that opt in via
 * `with auditable` (or by writing `implements "auditable"` directly)
 * receive the stamps via the lowerer's capability-scoped propagation.
 *
 * Source-equivalent:
 *
 *   context Sales with audit {
 *     aggregate Order with auditable { subject: string }
 *   }
 *
 *   ↓
 *
 *   context Sales {
 *     stamp for "auditable" onCreate {
 *       createdAt := now()
 *       createdBy := currentUser
 *     }
 *     stamp for "auditable" onUpdate {
 *       updatedAt := now()
 *       updatedBy := currentUser
 *     }
 *     aggregate Order {
 *       subject: string
 *       createdAt: datetime
 *       // ... etc
 *       implements "auditable"
 *     }
 *   }
 *
 * Reading note: this carries the capability *behavior*; the sibling
 * `auditable` macro carries the per-aggregate *state* (fields +
 * `implements`).  They compose; `auditedByDefault` combines them. */
export default defineMacro({
  name: "audit",
  target: "context",
  apiVersion: 1,
  description:
    "Context-level capability stamps for the `auditable` group.  Stamps " +
    "createdAt/createdBy on create and updatedAt/updatedBy on update for " +
    'aggregates that opt in via `implements "auditable"`.',
  expand() {
    return contextStamp({
      capability: "auditable",
      onCreate: [
        { field: "createdAt", value: nowExpr() },
        { field: "createdBy", value: nameRef("currentUser") },
      ],
      onUpdate: [
        { field: "updatedAt", value: nowExpr() },
        { field: "updatedBy", value: nameRef("currentUser") },
      ],
    });
  },
});
