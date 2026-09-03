// -------------------------------------------------------------------------
// Tiny helpers shared by all four shape repositories (relational /
// embedded / document / event-sourced): the `raw(...)` fragment detector,
// the tenant-scoped `maskUserImport` line, and the repository-method
// parameter-type renderer.  Split out of mikroorm.ts by packet 2.6
// (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import type { EnrichedAggregateIR, RepositoryIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { aggHasFieldMask } from "../repository-wire-builder.js";

/**
 * The `User` type-only import a `mask unless` aggregate's repository needs.
 *
 * Every MikroORM repository variant emits `toWireMaskedMethod(agg)` when the
 * aggregate carries a `mask unless` field, and that method's signature is
 * `toWireMasked(root: T, currentUser: User | null)` — so the file names `User`
 * and must import it.  All four variants emitted the method without the import,
 * which made `mask unless` × `persistence: mikroorm` fail `tsc` with TS2304
 * (M-T9.29 finding F3; the drizzle relational builder has always applied this
 * rule — `typescript/repository-builder.ts`).  One helper rather than four
 * inline conditions, so the next variant cannot forget it independently.
 */
/**
 * Does an emitted repository body call MikroORM's `raw()` fragment helper?
 *
 * Body-scanned exactly like the `requireCurrentUser()` accessor, and for the
 * same reason: a repository that emits no raw fragment must keep a
 * byte-identical import list.  The only emitter that produces one today is the
 * hierarchical (`deep`/`global`) tenancy subtree predicate in
 * {@link authzFilterEntry} — a FilterQuery *key* built from raw SQL, since the
 * operator vocabulary has no prefix test.
 *
 * The negative lookbehind excludes a METHOD named `raw` (`x.raw(...)`), which
 * is not the imported helper.  The scan runs over the string-blanked body, so
 * the word cannot come from a string literal.
 */

export const usesRawFragment = (bodyScan: string): boolean => /(?<!\.)\braw\(/.test(bodyScan);

export const maskUserImport = (agg: EnrichedAggregateIR, repo?: RepositoryIR): string | false =>
  // …and the same rule now covers the SECOND way a repository names `User`: a
  // find whose `where` reads `currentUser` declares a trailing
  // `currentUser: User` parameter.  The event-sourced variant already spelled
  // this out (`repoUsesUser`); folding it in here keeps the other three from
  // rediscovering it one at a time.
  (aggHasFieldMask(agg) || (repo?.finds ?? []).some(findUsesCurrentUser)) &&
  `import type { User } from "../../auth/user-types";`;

/** TS type for a find parameter (id params are branded; scalars pass through). */

export function tsParamType(t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "id") return `Ids.${inner.targetName}Id`;
  if (inner.kind === "enum") return inner.name;
  if (inner.kind === "primitive") {
    switch (inner.name) {
      case "int":
      case "long":
        return "number";
      case "bool":
        return "boolean";
      case "datetime":
        return "Date";
      default:
        return "string";
    }
  }
  return "string";
}
