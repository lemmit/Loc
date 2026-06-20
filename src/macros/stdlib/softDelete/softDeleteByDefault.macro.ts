import { defineMacro, implementsCapabilityRef } from "../../api/index.js";

/** Apply soft-delete to every aggregate in a context (typed-capabilities.md).
 *
 * Emits a typed `implements softDeletable` on the CONTEXT host — the expander
 * applies that capability (isDeleted/deletedAt + filter) to every aggregate in
 * the context — and invokes the `softDelete` ops macro against each child to add
 * the `softDelete()`/`restore()` operations.
 *
 *   context Sales with softDeleteByDefault {
 *     aggregate Order   { subject: string }
 *     aggregate Customer { name: string }
 *   }
 *
 *   ↓ every aggregate gains isDeleted/deletedAt + `filter !this.isDeleted`
 *     (capability) and softDelete()/restore() (ops macro).
 *
 * The context-scoped typed `implements` is spliced during this macro's
 * expansion; the context's own typed-`implements` pass (which runs after the
 * `with` clause in `expandHost`) then fans the capability to the children. */
export default defineMacro({
  name: "softDeleteByDefault",
  target: "context",
  apiVersion: 1,
  description:
    "Applies the softDeletable capability (state + filter) and the softDelete " +
    "operations to every aggregate in the context.",
  expand({ target, invokeMacro }) {
    const aggregates = ((target as { members?: unknown[] }).members ?? []).filter(
      (m): m is { $type: "Aggregate" } =>
        !!m && typeof m === "object" && (m as { $type?: string }).$type === "Aggregate",
    );
    return [
      // Capability application on the context host → fans state + filter to all.
      implementsCapabilityRef("softDeletable"),
      // Operations on each child aggregate.
      ...aggregates.flatMap((agg) => invokeMacro("softDelete", { target: agg })),
    ] as never[];
  },
});
