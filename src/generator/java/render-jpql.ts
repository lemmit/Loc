import type { ExprIR } from "../../ir/types/loom-ir.js";

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
  return `${render(e.left, ctx)} ${op} ${render(e.right, ctx)}`;
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
