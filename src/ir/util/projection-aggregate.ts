// ---------------------------------------------------------------------------
// WHOLE-TABLE AGGREGATION in a query-time projection's `select`
// (read-path-architecture.md rev. 8's singleton read model — a dashboard total
// / running count).
//
// One detector, shared by every backend's projection emitter.  Each backend
// renders the aggregation in its own SQL dialect, but WHICH selects are an
// aggregation — and what type each result must be coerced to — is an IR fact,
// and five copies of it would drift.  The lowering already normalised the
// aggregation into `select.aggregate`; this is the small amount of reading on
// top that every emitter would otherwise repeat.
// ---------------------------------------------------------------------------

import { intrinsicFor } from "../../util/intrinsics.js";
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
   *  source row — optionally wrapped in one COMPUTED-key transform
   *  (`o.placedAt.startOfDay()`) — via
   *  `loom.projection-groupby-key-not-columnar`, so `groupKeyOf` can always
   *  name the bare column plus the transform applied to it. */
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

/** A COMPUTED grouping key's transform — the scalar intrinsic applied to the
 *  source column before grouping.  Deliberately a closed union rather than any
 *  catalogued intrinsic name: each entry has to be renderable in the SELECT,
 *  GROUP BY and ORDER BY of every backend's dialect, and the key's declared
 *  wire type has to survive it.  `startOfDay` truncates a `datetime` to
 *  midnight UTC (`date_trunc('day', …)`) and stays a `datetime` — the daily
 *  series bucket. */
export type GroupKeyTransform = "startOfDay";

/** The grouping key a validated `group by` / key-`select` expression names:
 *  the bare source column, plus the transform applied to it (absent for a
 *  plain column). */
export interface GroupKey {
  column: string;
  transform?: GroupKeyTransform;
}

/** Every catalogued intrinsic that may wrap a grouping column, keyed
 *  `<receiver>.<name>` (`intrinsicKey`).  Membership here is necessary but not
 *  sufficient — the catalogue row must also be `queryable` and take no
 *  arguments, both re-checked below, so a row that loses its queryability
 *  stops being a legal grouping key rather than emitting untranslatable SQL. */
const GROUP_KEY_TRANSFORMS: Record<string, GroupKeyTransform> = {
  "datetime.startOfDay": "startOfDay",
};

/** The catalogue key (`intrinsicKey(receiver, name)`) each transform maps to —
 *  the inverse of `GROUP_KEY_TRANSFORMS`.  Backends render a transformed key
 *  by looking this up in their own intrinsic SQL table, so the SELECT, GROUP BY
 *  and ORDER BY all get the byte-identical expression a `where`-position
 *  intrinsic would produce. */
export const GROUP_KEY_TRANSFORM_INTRINSIC: Record<GroupKeyTransform, string> = {
  startOfDay: "datetime.startOfDay",
};

/** The source column (and any transform) a validated grouping expression
 *  names, or `null` for any other shape (the validator rejects those before
 *  emit).
 *
 *  Two BARE spellings lower from the source-candidate scope: `o.status`
 *  becomes a member access on `this` whose `member` IS the schema column key
 *  (the same fact `aggregateColumn` uses for `sum(o.total)`), and a bare
 *  `status` becomes a `this-prop` ref.  A member on any OTHER receiver (a join
 *  alias, a param) is not a source column.
 *
 *  On top of those, ONE computed shape is admitted: a zero-arg queryable
 *  scalar intrinsic from `GROUP_KEY_TRANSFORMS` applied to a bare column
 *  (`o.placedAt.startOfDay()` — a `method-call` on the member, since the
 *  intrinsic is catalogue-resolved, not a distinct `ExprIR.kind`).  Comparing
 *  the WHOLE `GroupKey` is what keeps `select day = o.placedAt.startOfDay()`
 *  matched to `group by o.placedAt.startOfDay()` while a bare
 *  `select day = o.placedAt` against the same `group by` stays a
 *  `loom.projection-groupby-select-not-grouped`. */
export function groupKeyOf(e: ExprIR): GroupKey | null {
  const bare = bareColumn(e);
  if (bare !== null) return { column: bare };
  if (e.kind === "method-call" && e.args.length === 0 && !e.isCollectionOp) {
    const column = bareColumn(e.receiver);
    if (column === null) return null;
    if (e.receiverType.kind !== "primitive") return null;
    const transform = GROUP_KEY_TRANSFORMS[`${e.receiverType.name}.${e.member}`];
    if (!transform) return null;
    const sig = intrinsicFor(e.receiverType.name, e.member);
    if (!sig?.queryable || sig.params.length > 0) return null;
    return { column, transform };
  }
  return null;
}

function bareColumn(e: ExprIR): string | null {
  if (e.kind === "member" && e.receiver.kind === "this") return e.member;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  return null;
}

/** Two grouping keys name the same group iff BOTH the column and the transform
 *  agree — `o.placedAt` and `o.placedAt.startOfDay()` are different groups. */
export function sameGroupKey(a: GroupKey, b: GroupKey): boolean {
  return a.column === b.column && a.transform === b.transform;
}

/** LEGACY narrow reading: the bare source column, `null` for anything else —
 *  INCLUDING a computed key, which has no bare-column emission.  The backends
 *  that have not yet grown a transform arm still call this, and each throws on
 *  `null`; that loud failure is deliberate (a silent fallback to the untrimmed
 *  column would group every timestamp into its own bucket).  Prefer
 *  `groupKeyOf`. */
export function groupKeyColumn(e: ExprIR): string | null {
  const key = groupKeyOf(e);
  return key && key.transform === undefined ? key.column : null;
}

function declaredType(p: ProjectionIR, field: string): TypeIR | undefined {
  return p.wireShape?.find((f) => f.name === field)?.type;
}

function toAggregateSelect(
  p: ProjectionIR,
  s: { field: string; type: TypeIR; aggregate?: ProjectionAggregateIR },
): AggregateSelect {
  if (!s.aggregate)
    throw new Error("internal: toAggregateSelect takes aggregate-marked selects only");
  return { field: s.field, type: declaredType(p, s.field) ?? s.type, aggregate: s.aggregate };
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
  /** The result is `money`, so the wire string carries the FIXED
   *  `MONEY_WIRE_SCALE` (RS-12) rather than whatever scale the aggregate came
   *  back with.
   *
   *  A SQL aggregate's scale is not the declared type's: `sum`/`max`/`min` echo
   *  the scale the rows were STORED at (a `money("10.00")` write lands 2dp on a
   *  backend that persists the value as given), `avg` over a numeric widens it,
   *  and `NULL` over an empty table collapses to a bare `0`.  Every backend's
   *  ordinary aggregate read pins money to 4dp on the way out (`.toFixed(4)` /
   *  `money_str` / `setScale(4)` / `ToString("F4")` / `Decimal.round(_, 4)`);
   *  the projection path has to do the same, or the SAME declared `money` field
   *  reads back at a different scale depending on which route served it (#2549).
   *
   *  Separate from `asString` because that arm also covers `guid`, which must
   *  be stringified WITHOUT any numeric formatting. */
  isMoney: boolean;
  /** The field is nullable, so `NULL` stays null instead of collapsing to 0. */
  optional: boolean;
  /** `count` — always a number, always zero-defaulted. */
  isCount: boolean;
}

export function aggregateCoercion(s: AggregateSelect): AggregateCoercion {
  const inner = s.type.kind === "optional" ? s.type.inner : s.type;
  const optional = s.type.kind === "optional";
  const isMoney = inner.kind === "primitive" && inner.name === "money";
  const asString = isMoney || (inner.kind === "primitive" && inner.name === "guid");
  return {
    asString,
    isMoney,
    optional: optional && s.aggregate.op !== "count",
    isCount: s.aggregate.op === "count",
  };
}
