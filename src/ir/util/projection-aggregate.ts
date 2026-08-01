// ---------------------------------------------------------------------------
// WHOLE-TABLE AGGREGATION in a query-time projection's `select`
// (read-path-architecture.md rev. 8's singleton read model — a dashboard total
// / running count).  M-T1.3 Phase 0.
//
// One detector, shared by every backend's projection emitter.  Each backend
// renders the aggregation in its own SQL dialect, but WHICH selects are an
// aggregation — and what type each result must be coerced to — is an IR fact,
// and five copies of it would drift.  The lowering already normalised the
// aggregation into `select.aggregate`; this is the small amount of reading on
// top that every emitter would otherwise repeat.
// ---------------------------------------------------------------------------

import type { ProjectionAggregateIR, ProjectionIR, TypeIR } from "../types/loom-ir.js";

export interface AggregateSelect {
  /** The projection row field this fills. */
  field: string;
  /** The DECLARED row type — from `wireShape`, not the select's inferred type.
   *  The response schema is built from the declared row, so a coercion that
   *  followed the inferred type could disagree with it and fail at the wire
   *  boundary (a money sum coerced to a number where the schema says string). */
  type: TypeIR;
  aggregate: ProjectionAggregateIR;
}

/** The projection's `select`s when EVERY one is a whole-table aggregation — the
 *  singleton read model — else `null`.
 *
 *  All-or-nothing on purpose: a MIX of aggregate and per-row selects is a GROUP
 *  BY (one row per group), a different query and a different response shape.
 *  That combination is reserved (`loom.projection-groupby-unsupported`), so it
 *  never reaches an emitter; returning `null` for it would silently take the
 *  per-row path with an unresolved aggregation in it. */
export function wholeTableAggregates(p: ProjectionIR): AggregateSelect[] | null {
  const selects = p.query?.selects ?? [];
  if (selects.length === 0) return null;
  const out: AggregateSelect[] = [];
  for (const s of selects) {
    if (!s.aggregate) return null;
    const declared = p.wireShape?.find((f) => f.name === s.field)?.type;
    out.push({ field: s.field, type: declared ?? s.type, aggregate: s.aggregate });
  }
  return out;
}

/** How an aggregate result must be coerced, independent of dialect.
 *
 *  Postgres returns `numeric` aggregates as STRINGS through most drivers, and
 *  `NULL` over an empty table — so this is load-bearing rather than cosmetic.
 *
 *  `count` is the one operator with a meaningful zero: counting no rows is 0,
 *  not absent.  `sum` over no rows is SQL `NULL`; the row's declared type
 *  decides whether that surfaces as a zero or as null, and a non-optional
 *  declared field means zero. */
export interface AggregateCoercion {
  /** The result is carried on the wire as a string (`money`, `guid`). */
  asString: boolean;
  /** The field is nullable, so `NULL` stays null instead of collapsing to 0. */
  optional: boolean;
  /** `count` — always a number, always zero-defaulted. */
  isCount: boolean;
}

export function aggregateCoercion(s: AggregateSelect): AggregateCoercion {
  const inner = s.type.kind === "optional" ? s.type.inner : s.type;
  const optional = s.type.kind === "optional";
  const asString = inner.kind === "primitive" && (inner.name === "money" || inner.name === "guid");
  return {
    asString,
    optional: optional && s.aggregate.op !== "count",
    isCount: s.aggregate.op === "count",
  };
}
