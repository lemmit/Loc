import { contextFilter, defineMacro, memberAccess, not, thisRef } from "../../api/index.js";

/** Context-level companion to `softDeletable`.
 *
 * Declares the capability filter (`filter for "softDeletable"
 * !this.isDeleted`) once at the context level.  Aggregates that opt
 * in via `with softDeletable` (or by writing
 * `implements "softDeletable"` themselves) receive the filter via
 * the lowerer's capability-scoped propagation.
 *
 * Source-equivalent of:
 *
 *   context Sales with softDelete {
 *     aggregate Order with softDeletable { subject: string }
 *     aggregate Public { name: string }    // not filtered
 *   }
 *
 *   ↓
 *
 *   context Sales {
 *     filter for "softDeletable" !this.isDeleted
 *     aggregate Order { ... implements "softDeletable" ... }
 *     aggregate Public { name: string }
 *   }
 *
 * Reading note: this macro contains the capability *behavior*; the
 * sibling `softDeletable` macro contains the per-aggregate *state*
 * (fields, operations).  They compose: applying both yields a fully
 * functional soft-delete capability.  `softDeleteByDefault` combines
 * them in one go for every aggregate in the context. */
export default defineMacro({
  name: "softDelete",
  target: "context",
  apiVersion: 1,
  description:
    "Context-level capability filter for the `softDeletable` group.  " +
    "Hides rows whose `isDeleted` field is true from default reads, " +
    'but only for aggregates that opt in via `implements "softDeletable"`.',
  expand() {
    return [
      contextFilter(not(memberAccess(thisRef(), "isDeleted")), {
        capability: "softDeletable",
      }),
    ];
  },
});
