import type { ExprIR } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Capability-filter predicate → the static SQL fragment behind
// Hibernate's `@SQLRestriction` (the HasQueryFilter / Drizzle-WHERE
// analog: appended to every SELECT for the entity).  Only the
// non-principal, relational subset reaches this renderer — the
// validator gates currentUser-referencing filters and non-relational
// shapes (loom.context-filter-unsupported), so values here are
// literals / enum values / candidate paths only.
//
// Column naming mirrors the migrations builder: `snake(field)`, with
// VO sub-paths flattening to `<field>_<vofield>`.
// ---------------------------------------------------------------------------

export function renderSqlRestriction(e: ExprIR): string {
  switch (e.kind) {
    case "authz-filter":
      // Only the DENY carve-out (authorization Phase 4 — deny-wins) reaches the
      // static (no-principal) restriction path: the always-false `1 = 0`
      // appended to every SELECT for a read-denied entity.  A `scope` sentinel
      // is principal-referencing and is routed to the `tenantScope` Specification
      // instead, so it never lands here — the exhaustive switch throws if it did.
      switch (e.filter.kind) {
        case "deny":
          return "1 = 0";
        case "scope":
          throw unsupported("principal-referencing `scope` filter (needs the Specification path)");
        default: {
          const _exhaustive: never = e.filter;
          throw unsupported(`authz-filter kind '${(_exhaustive as { kind: string }).kind}'`);
        }
      }
    case "paren":
      return `(${renderSqlRestriction(e.inner)})`;
    case "unary":
      if (e.op === "!") return `not (${renderSqlRestriction(e.operand)})`;
      throw unsupported(`unary '${e.op}'`);
    case "binary": {
      if (e.op === "&&")
        return `${renderSqlRestriction(e.left)} and ${renderSqlRestriction(e.right)}`;
      if (e.op === "||")
        return `(${renderSqlRestriction(e.left)} or ${renderSqlRestriction(e.right)})`;
      const isNull = (x: ExprIR): boolean => x.kind === "literal" && x.lit === "null";
      if ((e.op === "==" || e.op === "!=") && (isNull(e.left) || isNull(e.right))) {
        const operand = isNull(e.left) ? e.right : e.left;
        return `${renderSqlRestriction(operand)} is${e.op === "!=" ? " not" : ""} null`;
      }
      const SQL_OP: Record<string, string> = {
        "==": "=",
        "!=": "<>",
        "<": "<",
        "<=": "<=",
        ">": ">",
        ">=": ">=",
      };
      const op = SQL_OP[e.op];
      if (!op) throw unsupported(`binary '${e.op}'`);
      return `${renderSqlRestriction(e.left)} ${op} ${renderSqlRestriction(e.right)}`;
    }
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") return snake(e.name);
      if (e.refKind === "enum-value") return sqlString(e.name);
      throw unsupported(`ref '${e.refKind}' (only candidate fields and enum values are static)`);
    case "member": {
      // Candidate field (`this.isDeleted` → is_deleted), flattened VO
      // sub-path (`this.audit.deletedAt` → audit_deleted_at), or an enum
      // value spelled `Enum.value`.
      if (e.receiverType.kind === "enum") return sqlString(e.member);
      if (e.receiver.kind === "this") return snake(e.member);
      return `${renderSqlRestriction(e.receiver)}_${snake(e.member)}`;
    }
    case "literal":
      switch (e.lit) {
        case "string":
          return sqlString(e.value);
        case "int":
        case "long":
        case "decimal":
        case "money":
          return e.value;
        case "bool":
          return e.value;
        default:
          throw unsupported(`literal '${e.lit}'`);
      }
    default:
      throw unsupported(`expression kind '${e.kind}'`);
  }
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function unsupported(what: string): Error {
  return new Error(
    `@SQLRestriction renderer: ${what} is outside the static-filter subset — ` +
      `the IR validator (loom.context-filter-unsupported) should have rejected this filter.`,
  );
}
