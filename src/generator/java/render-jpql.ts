import type { ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import {
  DATA_KEY_PATH_DELIMITER,
  isDeepScopeFilter,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";

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
    case "method-call":
      // `deep` read level (multi-tenancy Phase 2 P2.4) — descendant-or-self
      // materialized-path scope with the NULL-dataKey fallback to the tenant
      // floor (see `DEEP_SCOPE_SEMANTICS`).  The principal claims render as the
      // same null-safe SpEL accessors the tenant floor uses (`render` on the
      // `currentUser.<claim>` arg members).
      if (isDeepScopeFilter(e)) {
        const col = `${ctx.alias}.${TENANT_OWNED_DATA_KEY_FIELD}`;
        const tenantCol = `${ctx.alias}.${TENANT_OWNED_TENANT_ID_FIELD}`;
        const org = render(e.args[0]!, ctx);
        const tenant = render(e.args[1]!, ctx);
        const like = `${col} like concat(${org}, '${DATA_KEY_PATH_DELIMITER}%')`;
        return (
          `(${col} is not null and (${col} = ${org} or ${like})) ` +
          `or (${col} is null and ${tenantCol} = ${tenant})`
        );
      }
      // Reference-collection membership: `this.<refColl>.contains(x)` →
      // `:x member of e.<refColl>`.
      if (e.member === "contains" && e.receiverType.kind === "array" && e.args.length === 1) {
        return `${render(e.args[0]!, ctx)} member of ${render(e.receiver, ctx)}`;
      }
      throw unsupported(`method call '${e.member}'`);
    default:
      throw unsupported(`expression kind '${e.kind}'`);
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return `'${value.replace(/'/g, "''")}'`;
  if (lit === "null") return "null";
  if (lit === "bool") return value;
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

function renderBinary(e: Extract<ExprIR, { kind: "binary" }>, ctx: JpqlCtx): string {
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
