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

import type { ExprIR, ProjectionAggregateIR, ProjectionIR, TypeIR } from "../types/loom-ir.js";

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
 *  BY (one row per group), a different query and a different response shape —
 *  that is the GROUPED read (`group by` clause, `groupedAggregates` below), so
 *  a projection carrying `groupBy` never takes this path even when every select
 *  aggregates.  A mix WITHOUT `group by` is rejected by validation
 *  (`loom.projection-groupby-missing`), so it never reaches an emitter;
 *  returning `null` for it would silently take the per-row path with an
 *  unresolved aggregation in it. */
export function wholeTableAggregates(p: ProjectionIR): AggregateSelect[] | null {
  if ((p.query?.groupBy?.length ?? 0) > 0) return null;
  const selects = p.query?.selects ?? [];
  if (selects.length === 0) return null;
  const out: AggregateSelect[] = [];
  for (const s of selects) {
    if (!s.aggregate) return null;
    out.push(toAggregateSelect(p, s));
  }
  return out;
}

/** One grouping key of a GROUPED projection — a per-row `select` that names a
 *  grouping column.  `type` follows the same declared-over-inferred rule as
 *  `AggregateSelect.type`. */
export interface GroupKeySelect {
  /** The projection row field this fills. */
  field: string;
  /** The DECLARED row type (from `wireShape`) — see `AggregateSelect.type`. */
  type: TypeIR;
  /** The key's column expression, source-row-rooted (`this.status` after
   *  `o.status` lowers).  Validation pins it to a single-hop member on the
   *  source row (`loom.projection-groupby-key-not-columnar`), so
   *  `groupKeyColumn` can always name the bare column. */
  expr: ExprIR;
}

/** The disciplined reading of a GROUPED projection (`group by` present):
 *  grouping-key selects + per-group aggregate selects + the raw grouping
 *  columns, or `null` when the projection is not grouped.
 *
 *  The GROUP-BY twin of `wholeTableAggregates`, shared for the same reason —
 *  WHICH selects are keys vs aggregates, and what type each coerces to, is an
 *  IR fact five emitters would otherwise re-derive and drift on.  Validation
 *  guarantees the shape before any emitter sees it: at least one aggregate
 *  select, every per-row select structurally matching a `group by` column, and
 *  every `group by` column a bare source column.  The response is the LIST
 *  shape — one row per distinct key combination, ordered by the grouping
 *  columns (deterministic across backends). */
export interface GroupedSelects {
  /** Per-row grouping-key selects, in declaration order. */
  keys: GroupKeySelect[];
  /** Per-group aggregate selects (same coercion contract as the singleton). */
  aggregates: AggregateSelect[];
  /** The `group by` columns as written — a superset of `keys`' expressions
   *  (a column may be grouped without being selected).  Emitters GROUP BY and
   *  ORDER BY exactly these. */
  groupBy: ExprIR[];
}

export function groupedAggregates(p: ProjectionIR): GroupedSelects | null {
  const groupBy = p.query?.groupBy ?? [];
  if (groupBy.length === 0) return null;
  const keys: GroupKeySelect[] = [];
  const aggregates: AggregateSelect[] = [];
  for (const s of p.query?.selects ?? []) {
    if (s.aggregate) aggregates.push(toAggregateSelect(p, s));
    else keys.push({ field: s.field, type: declaredType(p, s.field) ?? s.type, expr: s.expr });
  }
  return { keys, aggregates, groupBy };
}

/** The bare source column a validated grouping expression names, or `null` for
 *  any other shape (the validator rejects those before emit).  Two spellings
 *  lower from the source-candidate scope: `o.status` becomes a member access on
 *  `this` whose `member` IS the schema column key (the same fact
 *  `aggregateColumn` uses for `sum(o.total)`), and a bare `status` becomes a
 *  `this-prop` ref.  A member on any OTHER receiver (a join alias, a param) is
 *  not a source column. */
export function groupKeyColumn(e: ExprIR): string | null {
  if (e.kind === "member" && e.receiver.kind === "this") return e.member;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  return null;
}

function declaredType(p: ProjectionIR, field: string): TypeIR | undefined {
  return p.wireShape?.find((f) => f.name === field)?.type;
}

function toAggregateSelect(
  p: ProjectionIR,
  s: { field: string; type: TypeIR; aggregate?: ProjectionAggregateIR },
): AggregateSelect {
  return {
    field: s.field,
    type: declaredType(p, s.field) ?? s.type,
    // biome-ignore lint/style/noNonNullAssertion: callers only pass aggregate-marked selects
    aggregate: s.aggregate!,
  };
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
