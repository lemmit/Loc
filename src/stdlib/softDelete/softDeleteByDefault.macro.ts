import { defineMacro } from "../../macro-api/index.js";

/** Apply soft-delete to every aggregate in a context.
 *
 * Composes the other two trio members via `invokeMacro`:
 *   - Calls `softDelete` against the context itself, emitting the
 *     capability filter (`filter for "softDeletable" !this.isDeleted`).
 *   - For each child aggregate, calls `softDeletable` against it,
 *     emitting the fields, operations, and `implements "softDeletable"`.
 *
 * Source-equivalent:
 *
 *   context Sales with softDeleteByDefault {
 *     aggregate Order   { subject: string }
 *     aggregate Customer { name: string }
 *   }
 *
 *   ↓
 *
 *   context Sales {
 *     filter for "softDeletable" !this.isDeleted
 *
 *     aggregate Order {
 *       subject: string
 *       isDeleted: bool
 *       deletedAt: datetime?
 *       operation softDelete() { ... }
 *       operation restore()    { ... }
 *       implements "softDeletable"
 *     }
 *     aggregate Customer {
 *       name: string
 *       isDeleted: bool
 *       // ... etc
 *       implements "softDeletable"
 *     }
 *   }
 *
 * Macro-calling-macro composition is the same outside-in mechanism
 * `scaffold` already uses to fan page-generation across the
 * aggregates it's given. */
export default defineMacro({
  name: "softDeleteByDefault",
  target: "context",
  apiVersion: 1,
  description:
    "Applies soft-delete state and capability to every aggregate in the " +
    "context.  Composes the `softDelete` (context-level filter) and " +
    "`softDeletable` (aggregate-level state) macros via invokeMacro.",
  expand({ target, invokeMacro }) {
    const aggregates = ((target as { members?: unknown[] }).members ?? []).filter(
      (m): m is { $type: "Aggregate" } =>
        !!m && typeof m === "object" && (m as { $type?: string }).$type === "Aggregate",
    );
    return [
      // Capability filter on the context itself.
      ...invokeMacro("softDelete", { target }),
      // Per-aggregate state on each child.
      ...aggregates.flatMap((agg) => invokeMacro("softDeletable", { target: agg })),
    ] as never[];
  },
});
