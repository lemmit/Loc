import { defineMacro, field, mark, operation, primType } from "../macro-api/index.js";

/** Marks an aggregate as soft-deletable: a boolean flag and an
 * optional deletion timestamp, with `softDelete()` and `restore()`
 * operations that flip them.
 *
 * The `softDelete` capability flag carries the chosen field names
 * so generators can emit query filters (`where !isDeleted`) without
 * hardcoding the convention.
 *
 * Note on composition: combining `softDeletable` with `crudish` will
 * collide on `delete()` — use `crudish(updateOnly: true)` to opt
 * out of the hard-delete operation. */
export default defineMacro({
  name: "softDeletable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Adds isDeleted/deletedAt fields plus softDelete()/restore() " +
    "operations.  Generators apply query filters to hide soft-deleted " +
    "rows from default reads.",
  params: {
    field: { kind: "string", default: "isDeleted" },
    timestamp: { kind: "string", default: "deletedAt" },
  },
  expand({ args }) {
    return [
      field(args.field, primType("bool")),
      field(args.timestamp, primType("datetime", { optional: true })),
      mark("softDelete", { field: args.field, timestamp: args.timestamp }),
      // Bodies are intentionally empty for the foundation phase.
      // Once statement factories land (Phase 3 — crudish), these
      // will carry `assign` / `precondition` statements.
      operation("softDelete", [], []),
      operation("restore", [], []),
    ];
  },
});
