import type { ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { durationCtorOperand } from "../../ir/util/temporal.js";
import {
  DATA_KEY_PATH_DELIMITER,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
import type { DurationUnit } from "../../util/temporal.js";

// ---------------------------------------------------------------------------
// Find-filter → JPQL renderer.  Spring Data derived method names can't
// express an arbitrary `ExprIR` filter, so IR-derived finds render as
// `@Query` JPQL (java-backend.md framework recommendation).  This is a
// deliberately small renderer over the validator's *queryable* subset
// (`firstNonQueryableNode`): comparisons, boolean connectives, bare
// booleans, VO sub-columns, enum values, null checks, and
// reference-collection membership.  Anything outside that subset throws —
// IR validation rejects it upstream, so reaching the throw is a compiler
// bug, not a user error.
//
// `this` → the query alias (`e`); `param` refs → `:name` bind parameters;
// enum values render as fully-qualified JPQL enum literals.  A
// `currentUser.<field>` access (principal/tenancy filter) renders as a Spring
// Data SpEL parameter resolving the ambient request principal through the
// generated `CurrentUserAccessor` bean — the JPA analogue of node's
// `requireCurrentUser()`: `:#{@currentUserAccessor.user()?.<field>()}`.  The
// null-safe `?.` keeps it fail-closed (no actor → null → `= NULL` → no rows),
// mirroring the .NET / Phoenix behaviour.
// ---------------------------------------------------------------------------

/** Spring bean name of the generated `CurrentUserAccessor` @Component. */
const CURRENT_USER_BEAN = "currentUserAccessor";

export interface JpqlCtx {
  /** Query alias for the aggregate root (`e`). */
  alias: string;
  /** Fully-qualified package of the generated enums (for enum literals). */
  enumsPkg: string;
}

// JPQL-side scalar-intrinsic snippets (src/util/intrinsics.ts) — how a
// `queryable` intrinsic renders inside a `@Query` where-string.  The
// snippet receives the already-rendered receiver (and rendered args) and
// yields the JPQL function application.  JPQL functions apply to
// parameters as well as paths, so the same snippet serves BOTH the
// column side (`this.name.trim()` → `trim(e.name)`) and the value side
// (`q.trim()` → `trim(:q)`).  Exported for the intrinsic completeness
// test.
export const JPQL_INTRINSIC_SQL: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `trim(${recv})`,
  "string.toUpper": (recv) => `upper(${recv})`,
  "string.toLower": (recv) => `lower(${recv})`,
  // ---- numerics (A3 math batch) — Hibernate 6+ HQL: abs/round/floor are
  // standard; `ceil` is spelled CEILING; two-value min/max are the HQL-native
  // least()/greatest() (NOT the aggregate min/max).  Postgres round(numeric, n)
  // is already half-away-from-zero, matching the catalogue contract.
  "int.abs": (recv) => `abs(${recv})`,
  "long.abs": (recv) => `abs(${recv})`,
  "decimal.abs": (recv) => `abs(${recv})`,
  "money.abs": (recv) => `abs(${recv})`,
  "int.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `least(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `greatest(${recv}, ${args[0]})`,
  "decimal.round": (recv, args) =>
    args[0] !== undefined ? `round(${recv}, ${args[0]})` : `round(${recv})`,
  "money.round": (recv, args) =>
    args[0] !== undefined ? `round(${recv}, ${args[0]})` : `round(${recv})`,
  "decimal.floor": (recv) => `floor(${recv})`,
  "money.floor": (recv) => `floor(${recv})`,
  "decimal.ceil": (recv) => `ceiling(${recv})`,
  "money.ceil": (recv) => `ceiling(${recv})`,
};

export function renderJpqlWhere(e: ExprIR, ctx: JpqlCtx): string {
  return render(e, ctx);
}

function render(e: ExprIR, ctx: JpqlCtx): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "this":
      return ctx.alias;
    case "id":
      return `${ctx.alias}.id`;
    case "ref":
      return renderRef(e, ctx);
    case "member":
      // `currentUser.<field>` → SpEL reading the ambient request principal off
      // the CurrentUserAccessor bean (null-safe → fail-closed).
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
        return `:#{@${CURRENT_USER_BEAN}.user()?.${e.member}()}`;
      }
      // Property navigation: `this.shipTo.city` → `e.shipTo.city`
      // (embedded path).  JPQL navigates record components by name.
      return `${render(e.receiver, ctx)}.${e.member}`;
    case "paren":
      return `(${render(e.inner, ctx)})`;
    case "unary":
      if (e.op === "!") return `not (${render(e.operand, ctx)})`;
      return `${e.op}${render(e.operand, ctx)}`;
    case "binary":
      return renderBinary(e, ctx);
    case "authz-filter": {
      // Authorization/tenancy filter sentinels (M-T9.9) — a discriminated node
      // so a missing arm is a `tsc` error here, not a silent authorization
      // bypass.
      switch (e.filter.kind) {
        // DENY carve-out (authorization Phase 4 — deny-wins).  An always-false
        // JPQL predicate; no row satisfies `1 = 0`.
        case "deny":
          return "1 = 0";
        // `deep`/`global` read level (multi-tenancy Phase 2 P2.4) —
        // descendant-or-self materialized-path scope with the NULL-dataKey
        // fallback to the tenant floor (see `DEEP_SCOPE_SEMANTICS`).  The
        // principal claims render as the same null-safe SpEL accessors the
        // tenant floor uses (`render` on the `currentUser.<claim>` members).
        case "scope": {
          const col = `${ctx.alias}.${TENANT_OWNED_DATA_KEY_FIELD}`;
          const tenantCol = `${ctx.alias}.${TENANT_OWNED_TENANT_ID_FIELD}`;
          const org = render(e.filter.anchorClaim, ctx);
          const tenant = render(e.filter.tenantClaim, ctx);
          const like = `${col} like concat(${org}, '${DATA_KEY_PATH_DELIMITER}%')`;
          return (
            `(${col} is not null and (${col} = ${org} or ${like})) ` +
            `or (${col} is null and ${tenantCol} = ${tenant})`
          );
        }
        default: {
          const _exhaustive: never = e.filter;
          throw unsupported(`authz-filter kind '${(_exhaustive as { kind: string }).kind}'`);
        }
      }
    }
    case "method-call": {
      // (The `deep` / DENY authorization filter sentinels moved to the
      // discriminated `authz-filter` kind in M-T9.9 — handled in its own case
      // above, no longer a `method-call` marker here.)
      // Reference-collection membership: `this.<refColl>.contains(x)`.  The
      // collection is an `@ElementCollection` of an embeddable id
      // (`PokemonId(UUID value)`), so `:x member of e.<refColl>` throws at
      // runtime on Hibernate 6 ("Unsupported tuple comparison" — the element is
      // a tuple, the bind param is not).  Use a correlated existence subquery
      // with an embeddable-equality predicate instead, which Hibernate
      // decomposes per attribute (`p.value = :x.value`).
      if (e.member === "contains" && e.receiverType.kind === "array" && e.args.length === 1) {
        const coll = render(e.receiver, ctx);
        const val = render(e.args[0]!, ctx);
        const alias = `${coll.split(".").pop() ?? "elem"}_m`;
        return `exists (select 1 from ${coll} ${alias} where ${alias} = ${val})`;
      }
      // Queryable scalar intrinsic (src/util/intrinsics.ts) — render the
      // receiver recursively and apply the JPQL snippet.  Serves both the
      // column side (`this.name.trim()` → `trim(e.name)`) and the value
      // side (`q.trim()` → `trim(:q)`) — JPQL functions accept bind
      // parameters too.
      if (e.receiverType.kind === "primitive") {
        const sig = intrinsicFor(e.receiverType.name, e.member);
        const snippet = JPQL_INTRINSIC_SQL[intrinsicKey(e.receiverType.name, e.member)];
        if (sig?.queryable && snippet) {
          return snippet(
            render(e.receiver, ctx),
            e.args.map((a) => render(a, ctx)),
          );
        }
      }
      throw unsupported(`method call '${e.member}'`);
    }
    default:
      throw unsupported(`expression kind '${e.kind}'`);
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return `'${value.replace(/'/g, "''")}'`;
  if (lit === "null") return "null";
  if (lit === "bool") return value;
  // Loom `now()` — HQL's `instant` (the current instant, java.time.Instant;
  // Hibernate 6+ grammar `currentDateTimeFunction`), matching the `Instant`
  // this backend maps `datetime` to.  Renders `current_timestamp` on the
  // SQL side.  (Before A5 this fell through to the bare IR value `now`,
  // which no HQL grammar accepts — temporal where-clauses made it live.)
  if (lit === "now") return "instant";
  // ints / longs / decimals / money are numeric literals in JPQL.
  return value;
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>, ctx: JpqlCtx): string {
  switch (e.refKind) {
    case "param":
      return `:${e.name}`;
    case "this-prop":
    case "this-vo-prop":
      return `${ctx.alias}.${e.name}`;
    case "enum-value":
      // JPQL enum literals must be fully qualified.
      return `${ctx.enumsPkg}.${e.enumName}.${e.name}`;
    default:
      throw unsupported(`ref kind '${e.refKind}' ('${e.name}')`);
  }
}

// HQL duration-unit keyword per Loom duration unit (A5 temporal) — the
// `<magnitude> <unit>` "to duration" form of Hibernate 6+'s HQL grammar
// (`toDurationExpression: expression datetimeField`), which translates to
// native SQL interval arithmetic on Postgres.
const HQL_DURATION_UNIT: Record<DurationUnit, string> = {
  days: "day",
  hours: "hour",
  minutes: "minute",
};

function renderBinary(e: Extract<ExprIR, { kind: "binary" }>, ctx: JpqlCtx): string {
  // A5 temporal — `datetime ± days/hours/minutes(n)` renders as HQL
  // duration arithmetic: `(e.dueDate + 30 day)`.  Works on BOTH sides of a
  // comparison (a column path navigates, a `:param` datetime binds, and the
  // amount likewise binds or navigates).  Only the DIRECT constructor
  // operand form reaches here (paren-transparent) — exactly what
  // `firstNonQueryableNode` admits; the commuted `days(2) + q` normalizes
  // to `(:q + 2 day)` (addition commutes).  Loom `datetime - datetime` in
  // where-position stays rejected by the gate, so no arm is needed for it.
  if (e.op === "+" || e.op === "-") {
    const rightDur = durationCtorOperand(e.right);
    const leftDur = e.op === "+" ? durationCtorOperand(e.left) : null;
    const dur = rightDur ?? leftDur;
    const other = rightDur ? e.left : leftDur ? e.right : null;
    if (dur && other && !durationCtorOperand(other)) {
      const amount = render(dur.amount, ctx);
      return `(${render(other, ctx)} ${e.op} ${amount} ${HQL_DURATION_UNIT[dur.unit]})`;
    }
  }
  const isNull = (x: ExprIR): boolean => x.kind === "literal" && x.lit === "null";
  if ((e.op === "==" || e.op === "!=") && (isNull(e.left) || isNull(e.right))) {
    const operand = isNull(e.left) ? e.right : e.left;
    return `${render(operand, ctx)} is ${e.op === "==" ? "" : "not "}null`;
  }
  const op = jpqlOp(e.op);
  // Self-id vs principal-claim comparison (`this.id == currentUser.<claim>` —
  // the derived tenancy registry self-scope, Phase 1b).  The entity key is an
  // `@EmbeddedId` record (`OrganizationId(UUID value)`), so the comparison
  // navigates into its component (`e.id.value`) and the SpEL principal side
  // binds the claim AS the id's value type: a same-typed claim binds directly
  // (Hibernate 6 rejects a String parameter against a UUID path), a `string`
  // claim against a guid id converts in SpEL (`T(java.util.UUID).fromString`,
  // null-guarded so a missing principal stays the fail-closed `= NULL`).
  if (e.op === "==" || e.op === "!=") {
    const idSide = selfIdTypeOf(e.left) ? e.left : selfIdTypeOf(e.right) ? e.right : null;
    const other = idSide === e.left ? e.right : e.left;
    const claim = principalClaimOf(other);
    if (idSide && claim) {
      const idType = selfIdTypeOf(idSide)!;
      const idPath = `${ctx.alias}.id.value`;
      const claimIsString = claim.type?.kind === "primitive" && claim.type.name === "string";
      const spel =
        idType.valueType === "guid" && claimIsString
          ? `:#{@${CURRENT_USER_BEAN}.user() == null || @${CURRENT_USER_BEAN}.user().${claim.member}() == null ? null : T(java.util.UUID).fromString(@${CURRENT_USER_BEAN}.user().${claim.member}())}`
          : `:#{@${CURRENT_USER_BEAN}.user()?.${claim.member}()}`;
      return idSide === e.left ? `${idPath} ${op} ${spel}` : `${spel} ${op} ${idPath}`;
    }
  }
  return `${render(e.left, ctx)} ${op} ${render(e.right, ctx)}`;
}

/** The id TypeIR of a `this.id` member access (the aggregate's own key), or
 *  null for any other shape. */
function selfIdTypeOf(x: ExprIR): Extract<TypeIR, { kind: "id" }> | null {
  if (x.kind === "paren") return selfIdTypeOf(x.inner);
  if (
    x.kind === "member" &&
    x.receiver.kind === "this" &&
    x.member === "id" &&
    x.memberType.kind === "id"
  ) {
    return x.memberType;
  }
  return null;
}

/** A `currentUser.<claim>` member access — returns the claim member name and
 *  its declared type, or null. */
function principalClaimOf(x: ExprIR): { member: string; type: TypeIR | undefined } | null {
  if (x.kind === "paren") return principalClaimOf(x.inner);
  if (x.kind === "member" && x.receiver.kind === "ref" && x.receiver.refKind === "current-user") {
    return { member: x.member, type: x.memberType };
  }
  return null;
}

function jpqlOp(op: string): string {
  switch (op) {
    case "==":
      return "=";
    case "!=":
      return "<>";
    case "&&":
      return "and";
    case "||":
      return "or";
    default:
      // <, <=, >, >=, +, -, *, / are JPQL-native.
      return op;
  }
}

function unsupported(what: string): Error {
  return new Error(
    `JPQL renderer: ${what} is outside the queryable subset — the IR validator should have rejected this filter.`,
  );
}
