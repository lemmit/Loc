// Platform-neutral aggregate-inheritance helpers (aggregate-inheritance.md).
//
// The single source of truth for the TPH (`sharedTable`) and TPC (`ownTable`)
// predicates every backend needs — "is this an abstract TPH/TPC base", "what
// are its concrete subtypes", "which table owns a concrete", "what `kind`
// discriminator value a concrete stamps", "which of a concrete's fields are
// its own vs inherited from the base".  They live under `ir/util/` (not a
// generator) so every backend — `typescript/`, `dotnet/`,
// `elixir/` — and the system migration builder consume them
// without importing across platform folders (the one-directional layering
// rule: `generator/<platform>` knows nothing about other platforms).

import type { AggregateIR, FieldIR } from "../types/loom-ir.js";

/** The aggregate pool a base is resolved within — a context's aggregate
 *  list.  All helpers take this so the base/concrete relationship resolves
 *  identically for every emitter. */
export type AggPool = readonly AggregateIR[];

/** Default inheritance layout when the modifier is omitted — TPH
 *  (`sharedTable`), the documented default (aggregate-inheritance.md). */
const DEFAULT_LAYOUT = "sharedTable" as const;

/** The abstract base `agg` extends (resolved within `pool`), or undefined
 *  when `agg` is not a subtype / the base is in another context. */
export function baseOf(agg: AggregateIR, pool: AggPool): AggregateIR | undefined {
  if (!agg.extendsAggregate) return undefined;
  return pool.find((a) => a.name === agg.extendsAggregate);
}

/** `agg`'s ancestor chain (its `extends` bases resolved within `pool`),
 *  nearest first and root last.  A `seen` guard keeps a malformed cycle
 *  finite (the language-side `extends`-cycle validator rejects these
 *  upstream; this just prevents an infinite loop if one slips through). */
function chainOf(agg: AggregateIR, pool: AggPool): AggregateIR[] {
  const out: AggregateIR[] = [];
  let cur = agg;
  const seen = new Set<string>();
  while (cur.extendsAggregate && !seen.has(cur.name)) {
    seen.add(cur.name);
    const base = pool.find((a) => a.name === cur.extendsAggregate);
    if (!base) break;
    out.push(base);
    cur = base;
  }
  return out;
}

/** The root-most base of `agg`'s `extends` chain, or `agg` itself when it is
 *  a root (declares no `extends`).  In a multi-level chain (`Dog extends Pet
 *  extends Animal`) every intermediate base is abstract and owns no table —
 *  the single shared TPH table lives at the root. */
export function rootBaseOf(agg: AggregateIR, pool: AggPool): AggregateIR {
  const chain = chainOf(agg, pool);
  return chain.length > 0 ? chain[chain.length - 1] : agg;
}

/** True when `agg` descends (transitively) from the base named `baseName`. */
function descendsFrom(agg: AggregateIR, baseName: string, pool: AggPool): boolean {
  return chainOf(agg, pool).some((a) => a.name === baseName);
}

/** Effective inheritance layout for a participant: its own override wins,
 *  else the root base's, else the `sharedTable` default.  Resolving via the
 *  root (not just the direct base) keeps a multi-level chain's layout coherent
 *  — a layout declared only on the root reaches every leaf. */
function effectiveLayout(agg: AggregateIR, pool: AggPool): "sharedTable" | "ownTable" {
  return agg.inheritanceUsing ?? rootBaseOf(agg, pool).inheritanceUsing ?? DEFAULT_LAYOUT;
}

/** True when `agg` is an abstract base whose hierarchy uses TPC (`ownTable`):
 *  no base table, each concrete a standalone table.  It owns no storage, but
 *  is the read home for the polymorphic `find all <Base>` reader (which
 *  delegates to the concrete repositories). */
export function isTpcBase(agg: AggregateIR, pool: AggPool): boolean {
  return !!agg.isAbstract && effectiveLayout(agg, pool) === "ownTable";
}

/** True when `agg` is a concrete subtype of a TPC (`ownTable`) base — a
 *  standalone table carrying the merged base fields. */
export function isTpcConcrete(agg: AggregateIR, pool: AggPool): boolean {
  const base = baseOf(agg, pool);
  return !!base?.isAbstract && !agg.isAbstract && effectiveLayout(agg, pool) === "ownTable";
}

/** The concrete subtypes of a TPC base — every concrete that descends from it
 *  (transitively, so a multi-level chain's leaves are all read homes). */
export function tpcConcretesOf(base: AggregateIR, pool: AggPool): AggregateIR[] {
  return pool.filter((a) => descendsFrom(a, base.name, pool) && isTpcConcrete(a, pool));
}

/** A concrete's OWN fields — its declared fields minus the base fields the
 *  enrichment pass merged in (matched by name).  The enrichment merge prepends
 *  inherited base fields, so a concrete's `fields` is `[...base, ...own]`; this
 *  recovers just the own tail so an emitter can declare base fields on the
 *  abstract base class and leave the concrete to inherit them. */
export function ownFieldsOf(concrete: AggregateIR, base: AggregateIR): FieldIR[] {
  const baseNames = new Set(base.fields.map((f) => f.name));
  return concrete.fields.filter((f) => !baseNames.has(f.name));
}

// ---------------------------------------------------------------------------
// TPH (`sharedTable`) predicates — the whole hierarchy lives in ONE table
// named for the abstract base, with a `kind` discriminator column and the
// per-concrete columns made nullable.  These are the single source of truth
// the schema emitter, the repository builders, and the migration builder
// consult so the owning table name + discriminator are derived identically
// on every backend.
// ---------------------------------------------------------------------------

/** True when `agg` is the ROOT abstract base of a TPH hierarchy — i.e. it owns
 *  the single shared table for itself and every concrete subtype in the chain.
 *  An intermediate abstract base (`Pet` in `Dog extends Pet extends Animal`)
 *  is NOT a TPH base: the whole hierarchy lives in the root's one table, so an
 *  intermediate owns no table and emits nothing. */
export function isTphBase(agg: AggregateIR, pool: AggPool): boolean {
  return (
    !!agg.isAbstract &&
    effectiveLayout(agg, pool) === "sharedTable" &&
    rootBaseOf(agg, pool) === agg
  );
}

/** True when `agg` is a concrete subtype that shares its TPH base's table
 *  (so it emits no table of its own; its repo/routes target the base table
 *  filtered by `kind`). */
export function isTphConcrete(agg: AggregateIR, pool: AggPool): boolean {
  const base = baseOf(agg, pool);
  return !!base?.isAbstract && !agg.isAbstract && effectiveLayout(agg, pool) === "sharedTable";
}

/** The aggregate name that owns the physical table for `agg`: the ROOT-most
 *  TPH base for a TPH concrete, otherwise `agg` itself.  In a multi-level
 *  chain (`Dog extends Pet extends Animal`, both bases abstract TPH) the
 *  direct base is itself abstract and owns no table — the single shared
 *  table lives at the top of the chain, so walk `extends` to the root.
 *  A `seen` guard keeps a malformed cycle finite. */
export function tableOwnerName(agg: AggregateIR, pool: AggPool): string {
  return isTphConcrete(agg, pool) ? rootBaseOf(agg, pool).name : agg.name;
}

/** The `kind` discriminator value for a TPH concrete (its own name), or
 *  undefined when `agg` is not a TPH concrete. */
export function discriminatorValue(agg: AggregateIR, pool: AggPool): string | undefined {
  return isTphConcrete(agg, pool) ? agg.name : undefined;
}

/** The concrete subtypes that share a TPH base's table — every concrete that
 *  descends from it (transitively), so a multi-level chain's leaves all land
 *  their columns in the single root table. */
export function tphConcretesOf(base: AggregateIR, pool: AggPool): AggregateIR[] {
  return pool.filter((a) => descendsFrom(a, base.name, pool) && isTphConcrete(a, pool));
}
