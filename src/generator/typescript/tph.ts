// TPH (table-per-hierarchy) awareness for the Hono/Drizzle backend.
//
// Aggregate-inheritance (aggregate-inheritance.md) ships two layouts.
// `ownTable` (TPC) is handled structurally in the system orchestrator — the
// abstract base is dropped from the generation view and each concrete emits
// as a standalone table (carrying the merged base fields).  `sharedTable`
// (TPH) is the harder one and is implemented for Hono only (v1): the whole
// hierarchy lives in ONE table named for the abstract base, with a `kind`
// discriminator column and the per-concrete columns made nullable.  Each
// concrete's repository / routes target that shared table, filtering reads by
// `kind` and stamping `kind` on writes.
//
// These helpers are the single source of truth the schema emitter, the
// repository builders, and the per-aggregate emit loop consult so the table
// name + discriminator are derived identically everywhere.  All take the
// owning `EnrichedBoundedContextIR` so the base can be resolved within the
// context (cross-context bases are a later slice — see the IR-validate gate).

import type { AggregateIR, FieldIR } from "../../ir/types/loom-ir.js";

/** The aggregate pool a base is resolved within — a context's (or module's)
 *  aggregate list.  All helpers take this so the base/concrete relationship
 *  resolves the same way for the schema emitter, the repository builders, and
 *  the migration builder. */
export type AggPool = readonly AggregateIR[];

/** Default inheritance layout when the modifier is omitted — TPH
 *  (`sharedTable`), the documented default (aggregate-inheritance.md). */
const DEFAULT_LAYOUT = "sharedTable" as const;

/** The abstract base `agg` extends (resolved within `pool`), or undefined
 *  when `agg` is not a subtype / the base is in another context. */
function baseOf(agg: AggregateIR, pool: AggPool): AggregateIR | undefined {
  if (!agg.extendsAggregate) return undefined;
  return pool.find((a) => a.name === agg.extendsAggregate);
}

/** Effective inheritance layout for a participant: its own override wins,
 *  else the base's, else the `sharedTable` default. */
function effectiveLayout(agg: AggregateIR, pool: AggPool): "sharedTable" | "ownTable" {
  return agg.inheritanceUsing ?? baseOf(agg, pool)?.inheritanceUsing ?? DEFAULT_LAYOUT;
}

/** True when `agg` is an abstract base whose hierarchy uses TPH — i.e. it
 *  owns the single shared table for itself and its concrete subtypes. */
export function isTphBase(agg: AggregateIR, pool: AggPool): boolean {
  return !!agg.isAbstract && effectiveLayout(agg, pool) === "sharedTable";
}

/** True when `agg` is a concrete subtype that shares its TPH base's table
 *  (so it emits no table of its own; its repo/routes target the base table
 *  filtered by `kind`). */
export function isTphConcrete(agg: AggregateIR, pool: AggPool): boolean {
  const base = baseOf(agg, pool);
  return !!base?.isAbstract && !agg.isAbstract && effectiveLayout(agg, pool) === "sharedTable";
}

/** The aggregate name that owns the physical table for `agg`: the TPH base
 *  for a TPH concrete, otherwise `agg` itself. */
export function tableOwnerName(agg: AggregateIR, pool: AggPool): string {
  return isTphConcrete(agg, pool) ? agg.extendsAggregate! : agg.name;
}

/** The `kind` discriminator value for a TPH concrete (its own name), or
 *  undefined when `agg` is not a TPH concrete. */
export function discriminatorValue(agg: AggregateIR, pool: AggPool): string | undefined {
  return isTphConcrete(agg, pool) ? agg.name : undefined;
}

/** The concrete subtypes of a TPH base, in declaration order. */
export function tphConcretesOf(base: AggregateIR, pool: AggPool): AggregateIR[] {
  return pool.filter((a) => a.extendsAggregate === base.name && isTphConcrete(a, pool));
}

/** A TPH concrete's OWN fields — its declared fields minus the base fields
 *  the enrichment pass merged in (matched by name). */
export function ownFieldsOf(concrete: AggregateIR, base: AggregateIR): FieldIR[] {
  const baseNames = new Set(base.fields.map((f) => f.name));
  return concrete.fields.filter((f) => !baseNames.has(f.name));
}
