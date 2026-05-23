import { defineMacro } from "../macro-api/index.js";

/** Apply audit fields + capability to every aggregate in a context.
 *
 * Composes the other audit trio members via `invokeMacro`:
 *   - Calls `audit` against the context, emitting the stamping rules
 *     (`stamp for "auditable" onCreate/onUpdate { ... }`).
 *   - For each child aggregate, calls `auditable` against it,
 *     emitting the four audit fields and `implements "auditable"`.
 *
 * Source-equivalent of `context Sales with auditedByDefault { ... }`
 * applied to the contained aggregates: same as writing
 * `with audit` on the context plus `with auditable` on each child. */
export default defineMacro({
  name: "auditedByDefault",
  target: "context",
  apiVersion: 1,
  description:
    "Applies audit fields and stamping to every aggregate in the context.  " +
    "Composes the `audit` (context-level stamps) and `auditable` " +
    "(aggregate-level fields) macros via invokeMacro.",
  expand({ target, invokeMacro }) {
    const aggregates = ((target as { members?: unknown[] }).members ?? []).filter(
      (m): m is { $type: "Aggregate" } =>
        !!m && typeof m === "object" && (m as { $type?: string }).$type === "Aggregate",
    );
    return [
      ...invokeMacro("audit", { target }),
      ...aggregates.flatMap((agg) => invokeMacro("auditable", { target: agg })),
    ] as never[];
  },
});
