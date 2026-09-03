// -------------------------------------------------------------------------
// `ExprIR` → MikroORM `FilterQuery` where-clause rendering — capability
// context filters, the `ignoring` bypass, write-scope filters, and the
// get-by-id predicate builders every shape repository (relational /
// embedded / document / event-sourced) reads from.  Split out of
// mikroorm.ts by packet 2.6 (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import type { EnrichedAggregateIR, ExprIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { orientComparison } from "../../../ir/util/comparison-operands.js";
import {
  DATA_KEY_PATH_DELIMITER,
  deepScopeAnchorClaim,
  deepScopeTenantClaim,
  guidFromStringSelfScope,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../../ir/util/tenant-stance.js";
import { intrinsicFor, intrinsicKey, isQueryableBoolIntrinsic } from "../../../util/intrinsics.js";
import { snake } from "../../../util/naming.js";
import { SQL_LIKE_ESCAPE_CLAUSE, tsSubtreeLikePattern } from "../../_expr/subtree-like.js";
import { isReservedIdent } from "../../sql-reserved.js";
import { documentWriteScopeBody, writeScopeDeniesAll } from "../repository-document-builder.js";
import { GUID_CLAIM_RE_LITERAL } from "../repository-find-predicate.js";

// ---------------------------------------------------------------------------
// find `where` → MikroORM FilterQuery object literal. Minimal subset; throws on
// anything unsupported so the caller can emit a runtime-throwing stub body.
// ---------------------------------------------------------------------------

/**
 * How `currentUser.<claim>` renders by default: the AMBIENT request principal.
 *
 * The always-on capability-filter path uses this — those predicates ride every
 * read, including ones whose method signature has no principal parameter, so
 * they reach the principal through the request-scoped accessor (exactly as the
 * drizzle repository's `principalAccessor: "requireCurrentUser()"` option).
 *
 * A find whose OWN `where` names `currentUser` overrides it with the string
 * `"currentUser"`: `findUsesCurrentUser` gives that find a trailing
 * `currentUser: User` parameter, and every call site — the Hono route, the CQRS
 * handler — passes the request principal into it.  The two must agree, or the
 * route calls a method with one argument more than it declares (TS2554 in the
 * GENERATED project, invisible to the toolchain's own `tsc`).
 */

export const AMBIENT_PRINCIPAL = "requireCurrentUser()";

const FILTER_OP: Record<string, string> = {
  "<": "$lt",
  ">": "$gt",
  "<=": "$lte",
  ">=": "$gte",
  "!=": "$ne",
};

/** The FilterQuery property name for a `this`-rooted field access, or null.
 *  Accepts `this.<field>` (a `member` over `this` — the shape a repository
 *  `find ... where this.field` lowers to), a bare `this-prop` ref (`total` — the
 *  shape a projection `... where total` / criterion candidate field lowers to), and a
 *  VO subfield `this.<field>.<sub>` (→ the flattened `<field>_<sub>` column, the
 *  MikroORM twin of the drizzle `<field>_<sub>` column). */

function thisFieldColumn(e: ExprIR): string | null {
  if (e.kind === "member" && e.receiver.kind === "this") return e.member;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  if (e.kind === "member" && e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
    return `${e.receiver.member}_${e.member}`;
  return null;
}

// ---------------------------------------------------------------------------
// Queryable scalar intrinsics (`this.name.trim()`, `this.path.startsWith(p)`).
//
// The FilterQuery vocabulary has no function-call position at all, so an
// intrinsic can only reach SQL through a `raw()` fragment — used as the
// FilterQuery KEY, with the comparison's right-hand side as the value
// (`{ [raw("trim(name)")]: "x" }` → `trim(name) = 'x'`), or with an empty-array
// value when the fragment IS the whole predicate (a bool-returning intrinsic).
//
// The SQL is deliberately the SAME Postgres call the drizzle twin emits
// (`DRIZZLE_INTRINSIC_SQL` in `repository-find-predicate.ts`): two adapters of
// one platform must not disagree about what `round` or `startsWith` MEANS, and
// the only difference here is the wrapper (a `raw()` string vs a `sql` tag).
// ---------------------------------------------------------------------------

/** `receiver.member` → the Postgres call, given already-rendered SQL text for
 *  the receiver and each argument.  Mirrors `DRIZZLE_INTRINSIC_SQL` one-for-one;
 *  every entry puts the receiver FIRST, which is what lets the caller collect
 *  bind params in the order the `?` placeholders appear. */

export const MIKRO_INTRINSIC_SQL: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (r) => `trim(${r})`,
  "string.toUpper": (r) => `upper(${r})`,
  "string.toLower": (r) => `lower(${r})`,
  // Prefix match.  Anchored `starts_with`, never `LIKE ? || '%'`: the argument
  // is a VALUE, so a `%`/`_` inside it must match LITERALLY (the corpus fixture
  // `prefix-filter.ddd` asserts exactly that, alongside the delimiter trap).
  // `starts_with` has no pattern language, so no ESCAPE discipline is needed —
  // the same reasoning as the deep-scope subtree predicate above, and the twin
  // of drizzle's `strpos(col, $p) = 1`.
  "string.startsWith": (r, a) => `starts_with(${r}, ${a[0]})`,
  "int.abs": (r) => `abs(${r})`,
  "long.abs": (r) => `abs(${r})`,
  "decimal.abs": (r) => `abs(${r})`,
  "money.abs": (r) => `abs(${r})`,
  "int.min": (r, a) => `least(${r}, ${a[0]})`,
  "long.min": (r, a) => `least(${r}, ${a[0]})`,
  "decimal.min": (r, a) => `least(${r}, ${a[0]})`,
  "money.min": (r, a) => `least(${r}, ${a[0]})`,
  "int.max": (r, a) => `greatest(${r}, ${a[0]})`,
  "long.max": (r, a) => `greatest(${r}, ${a[0]})`,
  "decimal.max": (r, a) => `greatest(${r}, ${a[0]})`,
  "money.max": (r, a) => `greatest(${r}, ${a[0]})`,
  "decimal.round": (r, a) => (a.length > 0 ? `round(${r}, ${a[0]})` : `round(${r})`),
  "money.round": (r, a) => (a.length > 0 ? `round(${r}, ${a[0]})` : `round(${r})`),
  "decimal.floor": (r) => `floor(${r})`,
  "money.floor": (r) => `floor(${r})`,
  "decimal.ceil": (r) => `ceil(${r})`,
  "money.ceil": (r) => `ceil(${r})`,
  "datetime.startOfDay": (r) => `date_trunc('day', ${r})`,
};

/** A column name in a raw-SQL identifier position: quoted when the word cannot
 *  appear bare in Postgres (`src/generator/sql-reserved.ts` owns the list),
 *  bare otherwise so no existing fragment moves. */

function mikroIdent(name: string): string {
  return isReservedIdent(name) ? `"${name}"` : name;
}

/** A raw SQL fragment plus the TypeScript expressions its `?` placeholders
 *  bind, in placeholder order. */

interface MikroRawFragment {
  sql: string;
  params: string[];
}

/** Render a COLUMN-position expression to raw SQL, appending any bind params.
 *  Returns null for a shape that is not a column / intrinsic-over-a-column.
 *
 *  Column identifiers are inlined as DB column names (`snake`) rather than
 *  bound: a FilterQuery key names entity PROPERTIES, but a raw fragment is SQL
 *  and is past the mapping layer.  Only VALUES bind — which is why a RESERVED
 *  name (`end`, `order`, `limit`, …) has to be quoted here: MikroORM's own
 *  `updateSchema()` quotes it when it creates the column, so the table is fine
 *  and only this fragment would be a runtime syntax error (F2-ADP-6).  The
 *  escaping is trivial on this backend — the fragment is `JSON.stringify`d into
 *  a TS string literal, so the `"` needs no further treatment (unlike Dapper's
 *  regular/verbatim split). */

function mikroColumnSql(e: ExprIR, params: string[], acc: string): string | null {
  const inner = e.kind === "paren" ? e.inner : e;
  const col = thisFieldColumn(inner);
  if (col !== null) return mikroIdent(snake(col));
  if (inner.kind === "method-call" && inner.receiverType.kind === "primitive") {
    const sig = intrinsicFor(inner.receiverType.name, inner.member);
    const render = MIKRO_INTRINSIC_SQL[intrinsicKey(inner.receiverType.name, inner.member)];
    if (!sig?.queryable || !render) return null;
    const recv = mikroColumnSql(inner.receiver, params, acc);
    if (recv === null) return null;
    // An argument may itself be a column (`this.a.min(this.b)` → `least(a, b)`);
    // anything else binds as a `?`.  Evaluated left to right AFTER the receiver,
    // which is the order the `?`s appear, because every snippet is receiver-first.
    const args: string[] = [];
    for (const a of inner.args) {
      const asColumn = mikroColumnSql(a, params, acc);
      if (asColumn !== null) {
        args.push(asColumn);
        continue;
      }
      params.push(filterValue(a, acc));
      args.push("?");
    }
    return render(recv, args);
  }
  return null;
}

/** A bool-returning queryable intrinsic standing alone in a PREDICATE position
 *  (`filter this.path.startsWith(p)`) — its SQL is already a complete
 *  predicate, so the fragment takes the empty-array value form. */

function boolIntrinsicFragment(e: ExprIR, acc: string): MikroRawFragment | null {
  const inner = e.kind === "paren" ? e.inner : e;
  if (
    inner.kind !== "method-call" ||
    inner.receiverType.kind !== "primitive" ||
    !isQueryableBoolIntrinsic(inner.receiverType.name, inner.member)
  )
    return null;
  const params: string[] = [];
  const sql = mikroColumnSql(inner, params, acc);
  return sql === null ? null : { sql, params };
}

/** `[raw("<sql>", [<params>])]: <value>` — one FilterQuery entry. */

function rawEntry(frag: MikroRawFragment, value: string): string {
  return `[raw(${JSON.stringify(frag.sql)}, [${frag.params.join(", ")}])]: ${value}`;
}

/** Render a `this.<col> <op> <param>` comparison as a `{ col: ... }` entry.
 *
 *  A FilterQuery has no left-hand VALUE position — the key is always the
 *  column — so a predicate written the other way round (`where 100 <
 *  this.qty`, which `MIKROORM_SUBSET` admits, since the capability descriptor
 *  walks a comparison's operands symmetrically) is commuted here, with the
 *  operator mirrored by the shared normalizer.  Requiring the column on the
 *  left instead is what made that validator-accepted shape emit the
 *  `not yet supported` runtime-throwing stub. */

function comparisonEntry(e: Extract<ExprIR, { kind: "binary" }>, acc: string): string {
  // FilterQuery keys are entity PROPERTY names (== field names), not DB
  // columns — or, for an intrinsic over a column, a `raw()` SQL fragment.
  // Either spelling counts as a column position for orientation purposes.
  const isColumnSide = (operand: ExprIR): boolean =>
    thisFieldColumn(operand) !== null || mikroColumnSql(operand, [], acc) !== null;
  const oriented = orientComparison(e.op, e.left, e.right, isColumnSide);
  if (oriented === null)
    throw new Error("mikroorm: unsupported find predicate (neither operand is this.<field>)");
  const col = thisFieldColumn(oriented.column);
  if (col === null) {
    // …unless the column side is an intrinsic over a column, which has no
    // FilterQuery spelling at all — it becomes a `raw()` KEY with the
    // comparison's value (or operator object) as the payload.
    const params: string[] = [];
    const sql = mikroColumnSql(oriented.column, params, acc);
    if (sql === null)
      throw new Error("mikroorm: unsupported find predicate (lhs not this.<field>)");
    const rhs = filterValue(oriented.value, acc);
    if (oriented.op === "==") return rawEntry({ sql, params }, rhs);
    const rawOp = FILTER_OP[oriented.op];
    if (!rawOp) throw new Error(`mikroorm: unsupported operator '${oriented.op}' in find`);
    return rawEntry({ sql, params }, `{ ${rawOp}: ${rhs} }`);
  }
  const rhs = filterValue(oriented.value, acc);
  if (oriented.op === "==") return `${col}: ${rhs}`;
  const op = FILTER_OP[oriented.op];
  if (!op) throw new Error(`mikroorm: unsupported operator '${oriented.op}' in find`);
  return `${col}: { ${op}: ${rhs} }`;
}

function filterValue(e: ExprIR, acc: string): string {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "param") return e.name;
      if (e.refKind === "enum-value") return JSON.stringify(e.name);
      throw new Error(`mikroorm: unsupported ref '${e.refKind}' in find`);
    case "member":
      // `currentUser.<claim>` — a principal-referencing (tenancy) capability
      // filter reads the ambient request principal via `requireCurrentUser()`,
      // exactly as the drizzle repository does; the value is compared against
      // the row column on the LHS.
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user")
        return `${acc}.${e.member}`;
      throw new Error("mikroorm: unsupported member value in find");
    case "literal":
      switch (e.lit) {
        case "string":
          return JSON.stringify(e.value);
        case "bool":
          return e.value;
        case "int":
        case "long":
        case "decimal":
        case "money":
          return e.value;
        default:
          throw new Error("mikroorm: unsupported literal in find");
      }
    default:
      throw new Error(`mikroorm: unsupported value '${e.kind}' in find`);
  }
}

/** `this.<field>` where field is a boolean column → the column name, else
 *  null.  MikroORM lowers a bare boolean column to `{ col: true }` (and
 *  `!this.col` to `{ col: false }`), the FilterQuery analogue of drizzle's
 *  `col = true`. */

function booleanColumnName(e: ExprIR): string | null {
  const inner = e.kind === "paren" ? e.inner : e;
  if (
    inner.kind === "member" &&
    inner.receiver.kind === "this" &&
    inner.memberType.kind === "primitive" &&
    inner.memberType.name === "bool"
  )
    return inner.member;
  if (
    inner.kind === "ref" &&
    inner.refKind === "this-prop" &&
    inner.type?.kind === "primitive" &&
    inner.type.name === "bool"
  )
    return inner.name;
  return null;
}

/** One conjunct → a single FilterQuery entry (`key: value`).  Handles
 *  comparisons (`col <op> value`), bare boolean columns (`this.active` →
 *  `active: true`), negated boolean columns (`!this.active` → `active:
 *  false`), and a general `!<compound>` (→ `$not: {...}`). */

function predicateEntry(e: ExprIR, acc: string): string {
  const inner = e.kind === "paren" ? e.inner : e;
  // Registry self-scope against a `string` tenancy claim (M-T3.7(c)) — the
  // MikroORM twin of the drizzle guard.  Binding the raw claim to a `uuid`
  // column makes Postgres reject the statement (`invalid input syntax for type
  // uuid`), so a malformed claim answers an ordinary bad token with a 500.
  // `{ id: null }` is MikroORM's `id IS NULL`, which no NOT NULL primary key
  // matches — the same empty read a foreign-but-well-formed claim gives.
  // Authorization/tenancy filter sentinels (M-T9.9).  A DISCRIMINATED node, so
  // a missing arm here is a `tsc` error rather than a fall-through to the
  // `unsupported find predicate` throw at the bottom of this function — which
  // is how the `deny` carve-out becomes unreachable on this adapter.  That is
  // the whole point of giving the sentinel its own `ExprIR.kind`.
  if (inner.kind === "authz-filter") return authzFilterEntry(inner, acc);
  const selfScope = guidFromStringSelfScope(inner);
  if (selfScope) {
    const claim = `${acc}.${selfScope.claim}`;
    return `id: ${GUID_CLAIM_RE_LITERAL}.test(${claim}) ? ${claim} : null`;
  }
  const boolCol = booleanColumnName(inner);
  if (boolCol) return `${boolCol}: true`;
  if (inner.kind === "unary" && inner.op === "!") {
    const negCol = booleanColumnName(inner.operand);
    if (negCol) return `${negCol}: false`;
    return `$not: ${whereToMikroFilter(inner.operand, acc)}`;
  }
  if (inner.kind === "binary" && (inner.op === "==" || FILTER_OP[inner.op] !== undefined)) {
    return comparisonEntry(inner, acc);
  }
  // A bool-returning queryable intrinsic standing ALONE in a boolean position
  // (`find under(p) where this.path.startsWith(p)`, or the same shape reached
  // through a `criterion` installed as a capability `filter`).  Its SQL already
  // IS a complete predicate, so the raw fragment takes the empty-array value.
  // Without this arm the shape fell through to the throw below — which the find
  // emitter turned into a runtime-throwing stub and the validator declared as a
  // `MIKROORM_SUBSET` narrowing.
  const boolFrag = boolIntrinsicFragment(inner, acc);
  if (boolFrag) return rawEntry(boolFrag, "[]");
  throw new Error(`mikroorm: unsupported find predicate '${inner.kind}'`);
}

/** The `authz-filter` sentinels as a MikroORM FilterQuery ENTRY (a `key: value`
 *  fragment `predicateEntry`'s callers splice into an object literal) — the
 *  MikroORM twin of Dapper's `authzFilterToSql` (`1 = 0`) and Drizzle's
 *  `and(isNull(id), isNotNull(id))`. */

function authzFilterEntry(e: Extract<ExprIR, { kind: "authz-filter" }>, acc: string): string {
  switch (e.filter.kind) {
    // DENY carve-out (authorization — deny-wins).  The always-false
    // term, ANDed into every read FilterQuery (and into the write-scope
    // existence pre-guard).  A genuine CONTRADICTION on the always-present
    // primary key rather than the bare `{ id: null }` this file uses elsewhere:
    // self-contained, needs no column beyond `id`, and does not lean on the PK
    // being NOT NULL.  `$and` keeps it ONE entry, so it composes with the
    // sibling entries `flattenAnd` merges into the same object literal.
    case "deny":
      return `$and: [{ id: null }, { id: { $ne: null } }]`;
    // `deep`/`global` read level (hierarchical tenancy) — the
    // materialized-path descendant-or-self sentinel, DEEP_SCOPE_SEMANTICS:
    //
    //   (data_key IS NOT NULL
    //      AND (data_key = ?
    //           OR (data_key like ? escape '!' AND strpos(data_key, ?) = 1)))
    //   OR (data_key IS NULL AND tenant_id = ?)
    //
    // The FilterQuery *operator* vocabulary genuinely cannot express a prefix
    // test — but MikroORM has a first-class escape hatch for exactly that, and
    // the shape is ordinary SQL.  `raw(sql, params)` used as a FilterQuery KEY
    // with an empty-array value (`{ [raw("…", […])]: [] }`) is the documented
    // way to AND a bare SQL condition into a find (`RawQueryFragment`), and it
    // composes with the sibling `$and` entries the same way every other entry
    // here does.  It must be built INSIDE the object literal at each call site
    // (never hoisted into a `const` shared by two queries): a raw fragment's
    // cache key is consumed on use, so two statements need two fragments — the
    // emitters splice this string per statement, which is what makes that true.
    //
    // The descendant test is TWO terms (M-T3.17).  The row is DECIDED by the
    // anchored `strpos(data_key, ?) = 1`, which has no pattern language: the
    // anchor is a principal CLAIM, i.e. data, and `_`/`%` inside it would be
    // LIKE wildcards — an org legitimately named `org_a` would match
    // `orgXa.leak`, a cross-tenant read with no attacker involved.  Binding the
    // value (which `raw`'s `?` does) stops injection, not pattern semantics.
    // The escaped `like ? escape '!'` in FRONT of it is a pure prefilter, there
    // so the planner can turn the fixed prefix into an index range over
    // `<table>_data_key_idx` instead of seq-scanning every row; an escaping
    // slip could only widen it, and the recheck still gates the row.  Same
    // two-term shape as the drizzle twin.
    //
    // The NULL branch is a deliberate OR-fallback, not fail-closed: a row
    // stamped before (or by a principal-less save) has no `data_key`, and
    // a bare prefix test would hide it from its own tenant.  It degrades to
    // exactly the flat floor — never wider.
    //
    // Columns are UNQUALIFIED (`data_key`, not `<alias>.data_key`), matching the
    // Dapper twin: every statement this fragment lands in is single-table
    // (`em.find`/`em.count` over one Row entity, or the QueryBuilder's direct
    // read of the source table), so there is nothing to be ambiguous with.
    case "scope": {
      const anchor = `${acc}.${deepScopeAnchorClaim(e)}`;
      const tenant = `${acc}.${deepScopeTenantClaim(e)}`;
      const col = snake(TENANT_OWNED_DATA_KEY_FIELD);
      const tenantCol = snake(TENANT_OWNED_TENANT_ID_FIELD);
      const sql =
        `((${col} is not null and (${col} = ? ` +
        `or (${col} like ? ${SQL_LIKE_ESCAPE_CLAUSE} and strpos(${col}, ?) = 1))) ` +
        `or (${col} is null and ${tenantCol} = ?))`;
      const needle = `${anchor} + ${JSON.stringify(DATA_KEY_PATH_DELIMITER)}`;
      const params = `[${anchor}, ${tsSubtreeLikePattern(anchor)}, ${needle}, ${tenant}]`;
      return `[raw(${JSON.stringify(sql)}, ${params})]: []`;
    }
    default: {
      const _exhaustive: never = e.filter;
      throw new Error(`unhandled authz-filter kind: ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}

/** Conjunctions merge into one object; `||` becomes `$or`.  Bare boolean
 *  columns and unary `!` are lowered via `predicateEntry`.
 *
 *  Exported for the query-time projection routes (M-T6.23): an
 *  aggregation reads the source table directly through the QueryBuilder, and its
 *  `where` must lower through the SAME subset a find predicate does — a second
 *  lowering would be a second set of bugs.  Throws on a predicate outside the
 *  FilterQuery subset, which the caller turns into the adapter's usual
 *  runtime-throwing stub. */

export function whereToMikroFilter(e: ExprIR, acc: string = AMBIENT_PRINCIPAL): string {
  const inner = e.kind === "paren" ? e.inner : e;
  if (inner.kind === "binary" && inner.op === "&&") {
    const entries = flattenAnd(inner).map((c) => predicateEntry(c, acc));
    return `{ ${entries.join(", ")} }`;
  }
  if (inner.kind === "binary" && inner.op === "||") {
    return `{ $or: [${orBranches(inner)
      .map((b) => whereToMikroFilter(b, acc))
      .join(", ")}] }`;
  }
  return `{ ${predicateEntry(inner, acc)} }`;
}

/** Split a `&&` chain into its conjuncts (each rendered by `predicateEntry`). */

function flattenAnd(e: Extract<ExprIR, { kind: "binary" }>): ExprIR[] {
  const out: ExprIR[] = [];
  const visit = (n: ExprIR): void => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary" && inner.op === "&&") {
      visit(inner.left);
      visit(inner.right);
    } else {
      out.push(inner);
    }
  };
  visit(e);
  return out;
}

/** Split a `||` chain into its disjuncts (each a full FilterQuery object). */

function orBranches(e: Extract<ExprIR, { kind: "binary" }>): ExprIR[] {
  const out: ExprIR[] = [];
  const visit = (n: ExprIR): void => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary" && inner.op === "||") {
      visit(inner.left);
      visit(inner.right);
    } else {
      out.push(inner);
    }
  };
  visit(e);
  return out;
}

// ---------------------------------------------------------------------------
// Capability `filter` predicates (`filter <expr>` → AggregateIR.contextFilters).
//
// MikroORM has no global query filter (EF Core's `HasQueryFilter`), so — like
// drizzle — the repository ANDs each capability predicate into every root read.
// A NON-principal predicate lowers to a FilterQuery via `whereToMikroFilter`
// (guaranteed in-subset by `validateFindPredicateAdapterSupport`).  A
// PRINCIPAL-referencing filter (tenancy: `this.tenantId == currentUser.tenantId`)
// is applied too: `currentUser.<claim>` lowers against the ambient
// `requireCurrentUser()` accessor (exactly as the drizzle repository), so the
// tenant scope IS enforced on every mikro read.  A read's `ignoring *` /
// `ignoring <Cap>` bypass drops the capability-origin predicates it names.
// ---------------------------------------------------------------------------

interface FilterBypass {
  bypassAll?: boolean;
  bypassCaps?: string[];
}

/** The applicable capability filters for an aggregate as MikroORM FilterQuery
 *  object-literal strings, honoring a read's `ignoring` bypass. */

export function mikroContextFilters(agg: EnrichedAggregateIR, bypass?: FilterBypass): string[] {
  const filters = agg.contextFilters ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  const out: string[] = [];
  filters.forEach((pred, i) => {
    const origin = origins[i];
    // Only capability-origin (`undefined` = bare/hand-written) filters are
    // bypassable; `ignoring *` drops every origin, a named `ignoring` the match.
    if (origin !== undefined && (bypass?.bypassAll || (bypass?.bypassCaps ?? []).includes(origin)))
      return;
    // A principal filter takes the SAME path as any other: lower it, and let an
    // unlowerable one THROW.
    //
    // Deliberately NOT wrapped in a `try { … } catch { /* drop */ }`.  A
    // principal filter is not gated for FilterQuery-lowerability
    // (`validateFindPredicateAdapterSupport` skips it), so a shape that cannot
    // lower reaches here — and DROPPING a tenancy predicate is not a degraded
    // read, it is NO tenant predicate, i.e. every tenant's rows on every read.
    // A crash at generation is the strictly safer failure.  With
    // `authzFilterEntry` rendering the subtree sentinel there is no known
    // shape left to crash on.
    out.push(whereToMikroFilter(pred));
  });
  return out;
}

/** Merge a base FilterQuery object-literal with the aggregate's applicable
 *  capability filters (`$and`).  No filters → the base unchanged (byte-
 *  identical to the pre-filter output); a `{}` base is dropped from the AND. */

export function withContextFilters(base: string, caps: string[]): string {
  if (caps.length === 0) return base;
  const parts = base === "{}" ? caps : [base, ...caps];
  return parts.length === 1 ? parts[0]! : `{ $and: [${parts.join(", ")}] }`;
}

// ---------------------------------------------------------------------------
// Write-scope pre-guard (authorization / deny-write).
//
// `agg.writeScopeFilter` is the predicate an INSTANCE mutation's command load
// must satisfy when the write scope is strictly NARROWER than the read scope
// (an `allow write local` under a widened read, or a `deny write` carve-out).
// Every mutation route loads through `getById`, so that is where the narrowing
// is enforced: a row the caller may READ but not WRITE is indistinguishable
// from a missing one (404), and the ordinary `findById` read filter still
// hydrates the row afterwards.
//
// Until this landed, `writeScopeFilter` had ZERO readers in this file — a
// `deny write on X` (or a narrowed write ladder) generated clean on
// `persistence: mikroorm` and the mutation SUCCEEDED.  Byte-identical (plain
// `findById` + not-found throw) when the aggregate carries no narrowing.
// ---------------------------------------------------------------------------

/** The aggregate's `writeScopeFilter` as a MikroORM FilterQuery object-literal
 *  string, or null when the write scope does not narrow the read scope. */

function mikroWriteScopeFilter(agg: EnrichedAggregateIR): string | null {
  if (!agg.writeScopeFilter) return null;
  return whereToMikroFilter(agg.writeScopeFilter);
}

/** The `getById` body lines for a QUERYABLE-COLUMN shape (relational /
 *  embedded): an existence pre-guard counting rows that match BOTH the id and
 *  the write scope, then the ordinary `findById` load. */

export function mikroGetByIdLines(
  agg: EnrichedAggregateIR,
  idVar: string,
  rowClass: string,
): readonly string[] {
  const writeFilter = mikroWriteScopeFilter(agg);
  const guard = writeFilter
    ? [
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const inScope = await em.count(${rowClass}, { $and: [{ id: id as string }, ${writeFilter}] });`,
        `    if (inScope === 0) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
      ]
    : [];
  return [
    `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
    ...guard,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
  ];
}

/** The `getById` body lines for a BLOB shape (`shape: document`, event-sourced
 *  stream): neither has queryable columns, so the write scope is checked
 *  IN-APP over the loaded aggregate — the same place those shapes already
 *  evaluate their capability read filters. */

export function mikroBlobGetByIdLines(agg: EnrichedAggregateIR, idVar: string): readonly string[] {
  const notFound = `throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`;
  // `deny write` → the in-app form is the constant `false`, so no row is ever
  // writable: answer not-found without loading (and without emitting the
  // `if (!(false))` a constant-condition lint would flag).
  if (writeScopeDeniesAll(agg)) {
    return [
      `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
      `    // policy { deny write on ${agg.name} } — no row is in write scope.`,
      `    ${notFound}`,
      `  }`,
    ];
  }
  const pred = documentWriteScopeBody(agg, "found");
  const bind =
    pred && exprUsesCurrentUser(agg.writeScopeFilter as ExprIR)
      ? [`    const currentUser = requireCurrentUser();`]
      : [];
  return [
    `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
    ...bind,
    `    const found = await this.findById(id);`,
    `    if (!found) ${notFound}`,
    ...(pred ? [`    if (!(${pred})) ${notFound}`] : []),
    `    return found;`,
    `  }`,
  ];
}
