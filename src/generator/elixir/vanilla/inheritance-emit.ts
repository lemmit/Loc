// ---------------------------------------------------------------------------
// Vanilla aggregate-inheritance helpers (inheritance.md) — the TPH
// (`sharedTable`) / TPC (`ownTable`) decisions the schema / repository /
// changeset / context / controller emitters share so the generated Ecto
// output matches the migration's table layout.
//
// The single source of truth for "which table does this aggregate's schema
// point at", "does it carry a `kind` discriminator", "what `kind` value does a
// concrete stamp/filter by", and "is this an abstract base that must stay
// read-only (no write seam)" lives in `ir/util/inheritance.ts`; this module is
// the thin vanilla-side wrapper that bakes in the context's aggregate pool and
// exposes the table name + discriminator the emitters need.
//
// THE BUG THIS CLOSES (vanilla-phoenix-gaps.md §8): a TPH concrete's schema
// used to point at `snake(plural(agg.name))` (`customers` / `vendors`) — tables
// the migration never creates (TPH shares ONE table named for the abstract
// base, with a `kind` discriminator).  Reads 500'd at runtime with "relation
// customers does not exist".  The schema now resolves to the shared base table
// and carries `kind`; the repository filters every read by `kind` and stamps it
// on insert.  The abstract base emits a read-only polymorphic reader.
// ---------------------------------------------------------------------------

import type { AggregateIR, FieldIR } from "../../../ir/types/loom-ir.js";
import {
  discriminatorValue,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import { plural, snake } from "../../../util/naming.js";

export {
  baseOf,
  discriminatorValue,
  isTpcBase,
  isTpcConcrete,
  isTphBase,
  isTphConcrete,
  tableOwnerName,
  tpcConcretesOf,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";

/** The Ecto `schema "<table>"` name for an aggregate — the SHARED base table
 *  (`parties`) for a TPH base or concrete, otherwise the aggregate's own
 *  pluralised table.  Mirrors `migrations-builder.ts` (which names the TPH
 *  table `plural(snake(base.name))`), so the generated schema and the migrated
 *  table always agree. */
export function vanillaTableName(agg: AggregateIR, pool: readonly AggregateIR[]): string {
  return snake(plural(tableOwnerName(agg, pool)));
}

/** True when the aggregate is an abstract base — it is never instantiated, so
 *  it emits NO write seam (insert/update/delete), no changeset, and a
 *  read-only controller.  Both TPH and TPC bases are read-only; the difference
 *  is only in how their polymorphic reader fetches rows (shared table vs
 *  delegation to the concrete repos). */
export function isAbstractBase(agg: AggregateIR): boolean {
  return agg.isAbstract === true;
}

/** The `kind` discriminator value a TPH CONCRETE stamps on insert and filters
 *  every read by — its own aggregate name (matching the migration's `kind`
 *  text column).  Undefined for non-TPH-concrete aggregates. */
export function tphKind(agg: AggregateIR, pool: readonly AggregateIR[]): string | undefined {
  return discriminatorValue(agg, pool);
}

/** The union of columns a TPH BASE schema must declare so the polymorphic
 *  reader can SELECT every subtype's fields off the shared table: the base's
 *  own fields, then every concrete's own fields (deduped by name, first wins).
 *  Mirrors `tphTableForAggregate` in `migrations-builder.ts` (minus `id`/`kind`,
 *  which the schema declares separately). */
export function tphBaseUnionFields(base: AggregateIR, pool: readonly AggregateIR[]): FieldIR[] {
  const seen = new Set<string>();
  const out: FieldIR[] = [];
  const push = (f: FieldIR): void => {
    if (seen.has(f.name)) return;
    seen.add(f.name);
    out.push(f);
  };
  for (const f of base.fields) push(f);
  for (const concrete of tphConcretesOf(base, pool)) {
    for (const f of ownFieldsOf(concrete, base)) push(f);
  }
  return out;
}
