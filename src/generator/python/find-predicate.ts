import {
  type AssociationIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type ExprIR,
  exprUsesCurrentUser,
  type ProjectionIR,
  type WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { tableOwnerName } from "../../ir/util/inheritance.js";
import { durationCtorOperand } from "../../ir/util/temporal.js";
import {
  DATA_KEY_PATH_DELIMITER,
  deepScopeAnchorClaim,
  isDeepScopeFilter,
  isDenyFilter,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
import { snake } from "../../util/naming.js";
import type { DurationUnit } from "../../util/temporal.js";
import { joinRowClassName, rowClassName } from "./py-columns.js";
import { PY_INTRINSIC_RENDERERS, renderPyExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// `where` predicate lowering — typed find-filter ExprIR → a SQLAlchemy
// boolean expression over the aggregate's Row class.  Covers exactly
// the queryable subset the IR validator (`firstNonQueryableNode`)
// admits: comparisons, &&/||/!, bare boolean columns, value-object
// sub-columns, enum values, parameters, literals, and
// `<refColl>.contains(x)` join-table membership (correlated EXISTS).
//
// The Python mirror of `lowerToDrizzle` / the .NET LINQ lowering —
// lowering never silently drops a predicate because the validator
// gated the expression shape first.
// ---------------------------------------------------------------------------

export interface PyPredicate {
  expr: string;
  /** sqlalchemy helpers the expression calls (`and_`, `or_`, `not_`,
   *  `select` for membership subqueries, `func` for column-side scalar
   *  intrinsics). */
  ops: Set<string>;
}

// SQL-side scalar-intrinsic snippets (src/util/intrinsics.ts) — how a
// `queryable` intrinsic applied to a COLUMN renders inside a SQLAlchemy
// predicate.  The snippet receives the already-lowered column expression
// (and lowered value args) and yields a `func.<fn>(…)` call; callers add
// `func` to the predicate's `ops` import set.  Value-side intrinsic
// applications (a param receiver — `q.trim()`) render through the plain
// Python snippet table instead — the value side of a comparison is
// host-language code.  Exported for the intrinsic completeness test.
// The Python mirror of node's `DRIZZLE_INTRINSIC_SQL`.
export const SQLALCHEMY_INTRINSIC_SQL: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `func.trim(${recv})`,
  "string.toUpper": (recv) => `func.upper(${recv})`,
  "string.toLower": (recv) => `func.lower(${recv})`,
  // ---- numerics (A3 math batch) -------------------------------------------
  // Postgres round(numeric, n) is already half-away-from-zero (the catalogue
  // contract), so the SQL side needs no mode forcing; min/max are the
  // two-value LEAST/GREATEST, not the aggregates.
  "int.abs": (recv) => `func.abs(${recv})`,
  "long.abs": (recv) => `func.abs(${recv})`,
  "decimal.abs": (recv) => `func.abs(${recv})`,
  "money.abs": (recv) => `func.abs(${recv})`,
  "int.min": (recv, args) => `func.least(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `func.least(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `func.least(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `func.least(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `func.greatest(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `func.greatest(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `func.greatest(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `func.greatest(${recv}, ${args[0]})`,
  "decimal.round": (recv, args) =>
    args[0] !== undefined ? `func.round(${recv}, ${args[0]})` : `func.round(${recv})`,
  "money.round": (recv, args) =>
    args[0] !== undefined ? `func.round(${recv}, ${args[0]})` : `func.round(${recv})`,
  "decimal.floor": (recv) => `func.floor(${recv})`,
  "money.floor": (recv) => `func.floor(${recv})`,
  "decimal.ceil": (recv) => `func.ceil(${recv})`,
  "money.ceil": (recv) => `func.ceil(${recv})`,
};

export function lowerToSqlAlchemy(
  e: ExprIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  opts?: {
    /** How a `currentUser.<field>` reference renders.  Defaults to the bare
     *  `current_user` name (the per-find `where` path threads it in as a method
     *  param).  The always-on principal-capability-filter path passes
     *  `"require_current_user()"` — the ambient principal accessor — so no read
     *  method needs a `current_user` parameter (DEBT-02; the SQLAlchemy analogue
     *  of node's `requireCurrentUser()` weave / EF Core's `HasQueryFilter`). */
    principalAccessor?: string;
  },
): PyPredicate | null {
  // TPH concretes query the base's shared table.
  return lowerOver(
    e,
    rowClassName(tableOwnerName(agg, ctx.aggregates)),
    agg.associations ?? [],
    opts?.principalAccessor ?? "current_user",
  );
}

/** Lower a workflow-sourced view's shorthand filter (workflow-instance-views.md)
 *  to a predicate over the saga-state `<Wf>Row`.  `this.<stateField>` refs bind
 *  to the row's columns exactly as an aggregate filter binds to its row; saga
 *  rows carry no reference collections, so the join-table `contains` arm never
 *  fires here. */
export function lowerWorkflowFilterToSqlAlchemy(e: ExprIR, wf: WorkflowIR): PyPredicate | null {
  return lowerOver(e, rowClassName(wf.name), [], "current_user");
}

/** Lower a projection-sourced view's filter (projection.md v1.1) to a predicate
 *  over the `<Proj>Row` read-model table — the SAME SQL-pushed path as a
 *  state-based workflow view, since a projection is always a physical row table
 *  (no event-sourced variant).  `this.<stateField>` refs bind to the row's
 *  columns; projection rows carry no reference collections, so the join-table
 *  `contains` arm never fires here. */
export function lowerProjectionFilterToSqlAlchemy(
  e: ExprIR,
  proj: ProjectionIR,
): PyPredicate | null {
  return lowerOver(e, rowClassName(proj.name), [], "current_user");
}

function lowerOver(
  e: ExprIR,
  row: string,
  associations: AssociationIR[],
  principalAccessor: string,
): PyPredicate | null {
  const ops = new Set<string>();
  const expr = lower(e, row, associations, ops, principalAccessor);
  if (expr == null) return null;
  return { expr, ops };
}

/** Positional-argument prefix per duration unit for Postgres
 *  `make_interval(years, ..., weeks, days, hours, mins, secs)` —
 *  SQLAlchemy's generic `func.` has no named-argument spelling, so the
 *  amount lands positionally after the right number of zeros (A5
 *  temporal).  The mirror of node's `MAKE_INTERVAL_ARG`. */
const MAKE_INTERVAL_ZEROS: Record<DurationUnit, number> = {
  days: 3,
  hours: 4,
  minutes: 5,
};

function lower(
  e: ExprIR,
  row: string,
  associations: AssociationIR[],
  ops: Set<string>,
  principalAccessor: string,
): string | null {
  switch (e.kind) {
    case "binary": {
      // A5 temporal — `datetime ± days/hours/minutes(n)` renders as
      // SQL interval arithmetic (`side ± make_interval(…, n)`), composing on
      // EITHER side of a comparison: a column stands as-is, a host value
      // (param / `now()`) wraps in `literal(...)` so the `±` dispatches
      // through SQLAlchemy (parameter-bound), and the amount likewise binds
      // (param / literal) or interpolates (column).  Only the DIRECT
      // constructor operand form lowers (paren-transparent) — mirroring
      // exactly what `firstNonQueryableNode` admits.  Loom
      // `datetime - datetime` in where-position is NOT lowered — the gate
      // rejects it, so no arm is needed here.
      if (e.op === "+" || e.op === "-") {
        const temporal = renderTemporalArith(e, row, associations, ops, principalAccessor);
        if (temporal != null) return temporal;
      }
      const l = lower(e.left, row, associations, ops, principalAccessor);
      const r = lower(e.right, row, associations, ops, principalAccessor);
      if (l == null || r == null) return null;
      if (e.op === "&&") {
        ops.add("and_");
        return `and_(${l}, ${r})`;
      }
      if (e.op === "||") {
        ops.add("or_");
        return `or_(${l}, ${r})`;
      }
      return `(${l} ${e.op} ${r})`;
    }
    case "unary": {
      const inner = lower(e.operand, row, associations, ops, principalAccessor);
      if (inner == null) return null;
      if (e.op === "!") {
        ops.add("not_");
        return `not_(${inner})`;
      }
      return `${e.op}${inner}`;
    }
    case "paren":
      return lower(e.inner, row, associations, ops, principalAccessor);
    case "ref":
      // `this.<col>` → the row column; everything else (params, lets,
      // enum values, currentUser) renders as a plain bind value.
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") {
        return `${row}.${snake(e.name)}`;
      }
      return renderPyExpr(e);
    case "member": {
      // `this.<col>` and `this.<vo>.<sub>` (flattened VO column).
      if (e.receiver.kind === "this") {
        return `${row}.${snake(e.member)}`;
      }
      if (e.receiver.kind === "member" && e.receiver.receiver.kind === "this") {
        return `${row}.${snake(`${e.receiver.member}_${e.member}`)}`;
      }
      // `currentUser.<claim>` — bind the principal's claim as a plain value.
      // The accessor is the source: a per-find `where` passes the threaded
      // `current_user` param; an always-on principal capability filter passes
      // `require_current_user()` (the ambient ContextVar accessor) so no read
      // method needs the principal as a parameter (DEBT-02).
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
        return `${principalAccessor}.${snake(e.member)}`;
      }
      // Param member access (e.g. a VO param's field) — plain value.
      return renderPyExpr(e);
    }
    case "method-call": {
      // DENY carve-out (authorization Phase 4 — deny-wins).  An always-false
      // predicate: a column can't be both NULL and NOT NULL.  Self-contained
      // (uses the always-present `id` column + `and_`, already an import here),
      // so no extra SQLAlchemy import and no self-comparison ruff lint.
      if (isDenyFilter(e)) {
        ops.add("and_");
        const idCol = `${row}.id`;
        return `and_(${idCol}.is_(None), ${idCol}.isnot(None))`;
      }
      // `deep` read level (multi-tenancy Phase 2 P2.4) — descendant-or-self
      // materialized-path scope with the NULL-dataKey fallback to the tenant
      // floor (see `DEEP_SCOPE_SEMANTICS`).  `Column.startswith(v)` lowers to
      // `LIKE v || '%'` (SQLAlchemy auto-escapes `%`/`_` in `v`).
      if (isDeepScopeFilter(e)) {
        const col = `${row}.${snake(TENANT_OWNED_DATA_KEY_FIELD)}`;
        const tenantCol = `${row}.${snake(TENANT_OWNED_TENANT_ID_FIELD)}`;
        // Anchor claim off `args[0]`: `orgPath` for `deep`, `rootOrg` for `global`.
        const org = `${principalAccessor}.${snake(deepScopeAnchorClaim(e))}`;
        const tenant = `${principalAccessor}.${snake(TENANT_OWNED_TENANT_ID_FIELD)}`;
        ops.add("or_");
        ops.add("and_");
        return (
          `or_(and_(${col}.isnot(None), or_(${col} == ${org}, ` +
          `${col}.startswith(${org} + ${JSON.stringify(DATA_KEY_PATH_DELIMITER)}))), ` +
          `and_(${col}.is_(None), ${tenantCol} == ${tenant}))`
        );
      }
      // `this.<refColl>.contains(x)` → correlated EXISTS against the
      // field's join table.
      if (
        e.member === "contains" &&
        e.receiverType.kind === "array" &&
        e.receiverType.element.kind === "id" &&
        e.args.length === 1
      ) {
        const fieldName =
          e.receiver.kind === "ref"
            ? e.receiver.name
            : e.receiver.kind === "member" && e.receiver.receiver.kind === "this"
              ? e.receiver.member
              : null;
        const assoc = fieldName ? associations.find((a) => a.fieldName === fieldName) : undefined;
        const arg = lower(e.args[0]!, row, associations, ops, principalAccessor);
        if (assoc && arg != null) {
          const join = joinRowClassName(assoc);
          ops.add("select");
          return `select(${join}).where(${join}.${assoc.ownerFk} == ${row}.id, ${join}.${assoc.targetFk} == ${arg}).exists()`;
        }
      }
      // Queryable scalar intrinsic (src/util/intrinsics.ts).  COLUMN side —
      // a `this`-rooted receiver (`this.name.trim()`) — wraps the lowered
      // column expression in its SQL snippet (`func.trim(Row.name)`), pulling
      // `func` into the import ops.  VALUE side — a param/let receiver
      // (`… == q.trim()`) — is plain host Python, so it renders through the
      // in-memory snippet table (`q.strip()`), mirroring how node splits
      // DRIZZLE_INTRINSIC_SQL (column) from TS_INTRINSIC_RENDERERS (value).
      if (e.receiverType.kind === "primitive") {
        const sig = intrinsicFor(e.receiverType.name, e.member);
        const key = intrinsicKey(e.receiverType.name, e.member);
        const sqlSnippet = SQLALCHEMY_INTRINSIC_SQL[key];
        if (sig?.queryable && sqlSnippet && isColumnRooted(e.receiver)) {
          const recv = lower(e.receiver, row, associations, ops, principalAccessor);
          const args = e.args.map((a) => lower(a, row, associations, ops, principalAccessor));
          if (recv == null || args.some((a) => a == null)) return null;
          ops.add("func");
          return sqlSnippet(recv, args as string[]);
        }
        if (sig?.queryable && PY_INTRINSIC_RENDERERS[key]) {
          return renderPyExpr(e);
        }
      }
      return null;
    }
    case "literal":
      return renderPyExpr(e);
    default:
      return null;
  }
}

/** A5 temporal — `datetime ± days/hours/minutes(n)` as a SQLAlchemy
 *  column expression: `(side ± func.make_interval(…, amount))`.  The
 *  positional zeros place the amount in the unit's `make_interval` slot; the
 *  amount is parameter-bound when it's a param/literal and interpolates when
 *  it's a column, exactly like any other lowered operand.  The datetime side
 *  is the lowered column expression when column-rooted (or itself a nested
 *  temporal fragment), else a host value wrapped in `literal(...)` so the
 *  native `±` dispatches through SQLAlchemy's operator overloads with the
 *  value bound as a parameter (`literal(q) + make_interval(0, 0, 0, 2)`).
 *  Returns null for every non-temporal shape (the caller falls through).
 *  The SQLAlchemy mirror of node's `renderTemporalArith`. */
function renderTemporalArith(
  e: ExprIR,
  row: string,
  associations: AssociationIR[],
  ops: Set<string>,
  principalAccessor: string,
): string | null {
  if (e.kind === "paren")
    return renderTemporalArith(e.inner, row, associations, ops, principalAccessor);
  if (e.kind !== "binary" || (e.op !== "+" && e.op !== "-")) return null;
  const rightDur = durationCtorOperand(e.right);
  const leftDur = e.op === "+" ? durationCtorOperand(e.left) : null;
  const dur = rightDur ?? leftDur;
  const other = rightDur ? e.left : leftDur ? e.right : null;
  if (!dur || !other || durationCtorOperand(other)) return null;
  // The datetime side: a nested temporal fragment / column lowers as-is;
  // a host value (param, `now()`) wraps in `literal(...)`.
  const nested = renderTemporalArith(other, row, associations, ops, principalAccessor);
  let side = nested ?? lower(other, row, associations, ops, principalAccessor);
  if (side == null) return null;
  if (nested == null && !isColumnRooted(other)) {
    ops.add("literal");
    side = `literal(${side})`;
  }
  const amount = lower(dur.amount, row, associations, ops, principalAccessor);
  if (amount == null) return null;
  ops.add("func");
  const zeros = "0, ".repeat(MAKE_INTERVAL_ZEROS[dur.unit]);
  return `(${side} ${e.op} func.make_interval(${zeros}${amount}))`;
}

/** True when the expression reads a `this`-rooted column — directly
 *  (`this.name` / bare `this-prop` ref), through a flattened VO member
 *  (`this.price.amount`), or through a nested intrinsic application — i.e.
 *  the side of a comparison that lowers to a SQL column expression rather
 *  than a plain Python bind value. */
function isColumnRooted(e: ExprIR): boolean {
  switch (e.kind) {
    case "paren":
      return isColumnRooted(e.inner);
    case "ref":
      return e.refKind === "this-prop" || e.refKind === "this-vo-prop";
    case "member":
      return (
        e.receiver.kind === "this" ||
        (e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
      );
    case "method-call":
      return isColumnRooted(e.receiver);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Capability filters (`filter <expr>` → AggregateIR.contextFilters).
//
// SQLAlchemy has no global query filter (the EF Core `HasQueryFilter`
// analogue), so the generated repository must AND each predicate into every
// root-table read site (find_by_id / find_many_by_ids / all / find* / view
// finds / retrievals).  Both shapes of relational filter are wired: the
// NON-principal case (e.g. `filter !this.isDeleted`) AND the PRINCIPAL case
// (`filter this.tenantId == currentUser.tenantId`, DEBT-02), the latter
// rendering `current_user.<claim>` against the ambient `require_current_user()`
// accessor so no read method gains a parameter.  Non-relational (document /
// embedded) principal filters stay gated by the IR validator
// (`validateContextFilterSupport`), so they never reach codegen here.
// ---------------------------------------------------------------------------

/** A read's capability filter-bypass spec (`ignoring <Cap>` / `ignoring *`),
 *  carried index-by-name on `FindIR` / `ViewIR` / the repo-run stmt.  Named
 *  capabilities are matched against `AggregateIR.contextFilterOrigins`; a
 *  filter whose origin is `undefined` (hand-written/bare) is never bypassable
 *  — only capability-contributed filters can be `ignoring`-dropped.  Mirrors
 *  node's `FilterBypass`. */
export interface FilterBypass {
  bypassAll?: boolean;
  bypassCaps?: string[];
}

/** True when the capability filter at `contextFilterOrigins[i]` is dropped by
 *  `bypass`: `ignoring *` drops every capability-origin filter; a named
 *  `ignoring <Cap>` drops only the matching origin.  An `undefined` origin
 *  (bare/hand-written filter) is never dropped. */
function isFilterBypassed(origin: string | undefined, bypass: FilterBypass | undefined): boolean {
  if (!bypass || origin === undefined) return false;
  if (bypass.bypassAll) return true;
  return (bypass.bypassCaps ?? []).includes(origin);
}

/** Lower an aggregate's capability filters — non-principal AND principal — to a
 *  single SQLAlchemy predicate (conjoined with `and_(...)` when there is more
 *  than one), or null when the aggregate has no capability filter.  Mirrors
 *  node's `contextFilterPredicate`.
 *
 *  A principal-referencing predicate (`this.tenantId == currentUser.tenantId`,
 *  DEBT-02) renders its `currentUser.<claim>` against the ambient
 *  `require_current_user()` accessor (the module-level `ContextVar[User | None]`
 *  the auth middleware sets) — so the predicate AND-s into every root read
 *  without any read method gaining a parameter, exactly like node's
 *  `requireCurrentUser()` weave / EF Core's `HasQueryFilter`.  The validator
 *  (`validateContextFilterSupport`) has already required `auth: required` + a
 *  system `user {}` block, so the accessor is guaranteed to be emitted.
 *
 *  Every kept predicate always lowers to a closed expression because the IR
 *  validator gated the queryable shape first; returns null (rather than
 *  throwing) on a non-lowerable predicate, which is unreachable for valid
 *  models.
 *
 *  When `bypass` is supplied (the read carried an `ignoring` clause), every
 *  capability filter whose `contextFilterOrigins[i]` the bypass names is
 *  OMITTED from the conjunction for that read only.  The origins array is
 *  index-aligned with the FULL `agg.contextFilters`, so the original index is
 *  carried through before bypass matching. */
export function contextFilterPredicate(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  bypass?: FilterBypass,
): PyPredicate | null {
  const kept = (agg.contextFilters ?? [])
    .map((predicate, i) => ({ predicate, origin: agg.contextFilterOrigins?.[i] }))
    .filter((e) => !isFilterBypassed(e.origin, bypass));
  if (kept.length === 0) return null;
  const ops = new Set<string>();
  const lowered: string[] = [];
  for (const { predicate } of kept) {
    // A principal-referencing filter renders `current_user.<claim>` against the
    // ambient `require_current_user()` accessor (no read-method parameter); a
    // non-principal filter lowers as before (the accessor default is unused).
    const l = lowerToSqlAlchemy(
      predicate,
      agg,
      ctx,
      exprUsesCurrentUser(predicate) ? { principalAccessor: "require_current_user()" } : undefined,
    );
    if (!l) return null;
    for (const op of l.ops) ops.add(op);
    lowered.push(l.expr);
  }
  if (lowered.length === 1) return { expr: lowered[0]!, ops };
  ops.add("and_");
  return { expr: `and_(${lowered.join(", ")})`, ops };
}

/** Lower an aggregate's `writeScopeFilter` (authorization Phase 3 P3.1 — the
 *  WRITE-ladder guard) to a single SQLAlchemy predicate, or null when the
 *  aggregate has no write-scope narrowing.  Renders `current_user.<field>`
 *  against the ambient `require_current_user()` accessor, exactly like the read
 *  capability filter. */
export function writeScopePredicate(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): PyPredicate | null {
  if (!agg.writeScopeFilter) return null;
  return lowerToSqlAlchemy(agg.writeScopeFilter, agg, ctx, {
    principalAccessor: "require_current_user()",
  });
}

/** True when the aggregate carries a principal-referencing capability `filter`
 *  (`currentUser.<claim>`).  Drives the repository module's
 *  `require_current_user` import gating — only those repos weave the ambient
 *  accessor into their root reads (DEBT-02).  The node analogue is
 *  `aggregateUsesPrincipalContextFilter`. */
export function aggUsesPrincipalContextFilter(agg: EnrichedAggregateIR): boolean {
  return (agg.contextFilters ?? []).some(exprUsesCurrentUser);
}

// ---------------------------------------------------------------------------
// IN-APP capability filter for a `shape(document)` aggregate (DEBT-02 tail).
//
// A document aggregate persists as ONE jsonb blob, which isn't per-field
// queryable, so its repository filters the REHYDRATED domain instances in-app
// (the SQLAlchemy analogue of node's `documentCapabilityBody` `.filter(...)`),
// instead of AND-ing a SQL `where` like the relational / embedded paths above.
// ---------------------------------------------------------------------------

/** Render an aggregate's capability filters as a single Python boolean
 *  expression over the rehydrated instance bound to `varName` — `this.<field>`
 *  → `<varName>.<field>` (the public getter), and a principal `currentUser.x`
 *  → `current_user.x`.  The caller binds `current_user = require_current_user()`
 *  once before the predicate when `usesPrincipal` is true (the ambient
 *  ContextVar accessor — no read-method parameter, mirroring node's
 *  `requireCurrentUser()` weave).  Multiple filters conjoin with ` and `.
 *
 *  `bypass` (a read's `ignoring` clause) drops the named capability-origin
 *  filters exactly like the relational `contextFilterPredicate`.  Returns null
 *  when no filter survives (no capability filter, or all bypassed) — emission
 *  then stays byte-identical to the pre-DEBT-02 document repository. */
export function documentCapabilityBody(
  agg: EnrichedAggregateIR,
  varName: string,
  bypass?: FilterBypass,
): { expr: string; usesPrincipal: boolean } | null {
  const kept = (agg.contextFilters ?? [])
    .map((predicate, i) => ({ predicate, origin: agg.contextFilterOrigins?.[i] }))
    .filter((e) => !isFilterBypassed(e.origin, bypass));
  if (kept.length === 0) return null;
  const expr = kept
    .map(({ predicate }) => `(${renderPyExpr(predicate, { thisName: varName })})`)
    .join(" and ");
  const usesPrincipal = kept.some(({ predicate }) => exprUsesCurrentUser(predicate));
  return { expr, usesPrincipal };
}
