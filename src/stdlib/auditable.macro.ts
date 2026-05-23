import { defineMacro, field, idRef, mark, primType } from "../macro-api/index.js";

/** Adds the standard four audit fields (createdAt/updatedAt/
 * createdBy/updatedBy) to an aggregate and marks it as auditable so
 * each backend generator can wire its shared persistence hook
 * (.NET: SaveChangesInterceptor on IAuditable entities;
 *  TS Drizzle: per-table middleware).
 *
 * The shared hook is generated **once per application** by iterating
 * the aggregates flagged `isAuditable` — there is no per-aggregate
 * lifecycle code in the macro body. */
export default defineMacro({
  name: "auditable",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Stamps createdAt/updatedAt/createdBy/updatedBy on every mutation. " +
    "Generators emit one shared persistence hook per application keyed " +
    "by the `IAuditable` capability.",
  expand() {
    return [
      field("createdAt", primType("datetime")),
      field("updatedAt", primType("datetime")),
      field("createdBy", idRef("User")),
      field("updatedBy", idRef("User")),
      mark("isAuditable"),
    ];
  },
});
