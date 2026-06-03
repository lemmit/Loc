// Repository predicate lowering — the `where`-clause oracle for the
// Hono/Drizzle backend.  Extracted from repository-find-builder.ts:
//
//   - lowerToDrizzle: IR `where` expression → Drizzle operator tree
//     (eq / ne / gt / … / and / or / not), or null for shapes Drizzle
//     can't represent in plain SQL (the validator rejects those).
//   - the capability-filter helpers (`filter <expr>` → contextFilters)
//     that lower onto every root read, plus the combinator that AND-s a
//     filter predicate into an existing read predicate.
//
// Pure leaf — the find method builders depend on these, never the reverse.

import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../ir/util/ref-collection.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { joinColumnName, joinTableConstName } from "./emit.js";
import { associationsOf } from "./repository-associations-builder.js";

// IR expression → Drizzle expression
//
// Lowers the common subset of `where`-clause expressions to Drizzle
// operators (eq / ne / gt / gte / lt / lte / and / or / not), keyed
// off `schema.<table>.<column>` references.  Returns null when the
// expression contains shapes Drizzle can't represent in plain SQL
// (collection ops, lambdas, member access into parts, etc.); the
// caller then falls back to a TODO comment.
// ---------------------------------------------------------------------------

const COMPARE_OP_TO_DRIZZLE: Record<string, string> = {
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

export interface DrizzleLowering {
  /** The TypeScript source for the whole expression. */
  expr: string;
  /** Operators referenced; caller adds them to the file's import line. */
  ops: Set<string>;
}

export function lowerToDrizzle(
  expr: ExprIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
): DrizzleLowering | null {
  const ops = new Set<string>();
  const text = lowerExpr(expr);
  if (text === null) return null;
  return { expr: text, ops };

  function lowerExpr(e: ExprIR): string | null {
    if (e.kind === "paren") return lowerExpr(e.inner);
    if (e.kind === "binary") {
      if (e.op === "&&" || e.op === "||") {
        const l = lowerExpr(e.left);
        const r = lowerExpr(e.right);
        if (l === null || r === null) return null;
        const fn = e.op === "&&" ? "and" : "or";
        ops.add(fn);
        return `${fn}(${l}, ${r})`;
      }
      const drizzleFn = COMPARE_OP_TO_DRIZZLE[e.op];
      if (!drizzleFn) return null;
      const colExpr = renderColumnRef(e.left) ?? renderColumnRef(e.right);
      const valueExpr =
        renderColumnRef(e.left) === null ? renderValue(e.left) : renderValue(e.right);
      if (colExpr === null || valueExpr === null) return null;
      ops.add(drizzleFn);
      return `${drizzleFn}(${colExpr}, ${valueExpr})`;
    }
    if (e.kind === "unary" && e.op === "!") {
      // A bare boolean column under `!` — `!this.isDeleted` — has no
      // comparison to lower, so normalise it to `not(eq(col, true))`.
      // (The same column standing alone in a boolean position is handled
      // by the bare-boolean fallback at the end of this function.)
      const col = booleanColumnRef(e.operand);
      if (col) {
        ops.add("not");
        ops.add("eq");
        return `not(eq(${col}, true))`;
      }
      const inner = lowerExpr(e.operand);
      if (inner === null) return null;
      ops.add("not");
      return `not(${inner})`;
    }
    // `this.<refColl>.contains(x)` — membership over a reference
    // collection.  Lowers to a subquery over the field's join table:
    // the owner row is matched iff a (owner, target=x) pair exists.
    if (
      e.kind === "method-call" &&
      e.member === "contains" &&
      e.receiverType.kind === "array" &&
      e.receiverType.element.kind === "id" &&
      e.args.length === 1
    ) {
      const fieldName = refCollectionFieldName(e.receiver);
      const owner = ctx.aggregates.find((a) => lowerFirst(plural(a.name)) === tableName);
      const assoc = owner
        ? associationsOf(owner).find((x) => x.fieldName === fieldName)
        : undefined;
      const arg = renderValue(e.args[0]!);
      if (!assoc || arg === null) return null;
      const joinConst = joinTableConstName(assoc);
      const ownerCol = joinColumnName(assoc.ownerFk);
      const targetCol = joinColumnName(assoc.targetFk);
      ops.add("inArray");
      ops.add("eq");
      return `inArray(schema.${tableName}.id, this.db.select({ id: schema.${joinConst}.${ownerCol} }).from(schema.${joinConst}).where(eq(schema.${joinConst}.${targetCol}, ${arg})))`;
    }
    // Bare boolean column standing alone in a boolean position
    // (`filter this.isActive`) — lower to `eq(col, true)`.
    const boolCol = booleanColumnRef(e);
    if (boolCol) {
      ops.add("eq");
      return `eq(${boolCol}, true)`;
    }
    return null;
  }

  /** A `this.<field>` (or bare `this-prop` ref) whose type is the
   *  primitive `bool`, rendered as its schema column — else null.  Lets
   *  the lowerer treat a bare boolean column as `eq(col, true)` in a
   *  boolean position (`filter this.isActive` / `filter !this.isDeleted`).
   *  Non-boolean columns return null so a bare non-bool column in a
   *  boolean slot stays a (correctly rejected) non-queryable shape. */
  function booleanColumnRef(e: ExprIR): string | null {
    if (e.kind === "paren") return booleanColumnRef(e.inner);
    const isBool = (t: TypeIR | undefined): boolean => t?.kind === "primitive" && t.name === "bool";
    if (e.kind === "member" && e.receiver.kind === "this" && isBool(e.memberType)) {
      return `schema.${tableName}.${e.member}`;
    }
    if (e.kind === "ref" && e.refKind === "this-prop" && isBool(e.type)) {
      return `schema.${tableName}.${e.name}`;
    }
    return null;
  }

  function renderColumnRef(e: ExprIR): string | null {
    if (e.kind === "paren") return renderColumnRef(e.inner);
    // `this.field` — direct column access.  In the IR this is a
    // `member` over the `this` literal.
    if (e.kind === "member" && e.receiver.kind === "this") {
      return `schema.${tableName}.${e.member}`;
    }
    // `this.field.subField` (value-object member access).  Schema
    // flattens VO fields into `<field>_<subField>` columns.
    if (
      e.kind === "member" &&
      e.receiver.kind === "member" &&
      e.receiver.receiver.kind === "this"
    ) {
      return `schema.${tableName}.${e.receiver.member}_${e.member}`;
    }
    // Bare-identifier reference to a `this` property (the validator
    // resolves these to `this-prop`).
    if (e.kind === "ref" && e.refKind === "this-prop") {
      return `schema.${tableName}.${e.name}`;
    }
    return null;
  }

  function renderValue(e: ExprIR): string | null {
    if (e.kind === "paren") return renderValue(e.inner);
    if (e.kind === "literal") {
      switch (e.lit) {
        case "string":
          return JSON.stringify(e.value);
        case "int":
        case "long":
        case "decimal":
          return e.value;
        case "money":
          // Drizzle's `numeric()` column accepts a string parameter
          // without precision loss — pass the literal's source value
          // directly, quoted.
          return JSON.stringify(e.value);
        case "bool":
          return e.value;
        case "null":
          return "null";
        default:
          return null;
      }
    }
    if (e.kind === "ref") {
      // Param / let / lambda: bare identifier.  Drizzle's `eq<T>` infers
      // `T` from the column on the left side; branded id types are
      // structurally assignable to the column's plain string/number
      // type, so a bare reference type-checks cleanly.  An older
      // version cast `${e.name} as never` defensively — that hid a
      // class of type errors (a where-clause referencing a renamed
      // column or a parameter with the wrong type compiled silently),
      // so the cast is gone.
      if (e.refKind === "param" || e.refKind === "let" || e.refKind === "lambda") {
        return e.name;
      }
      // Enum value: render as the literal string.  EF / Drizzle store
      // enums as text columns matching `OrderStatus.Draft` → "Draft".
      if (e.refKind === "enum-value") {
        return JSON.stringify(e.name);
      }
    }
    // `currentUser.<field>` — row-level filter.  The repo
    // method receives a `currentUser: User` parameter; the renderer
    // emits a plain JS member access against it.  Drizzle infers
    // the column-side branded type and the User field's plain type
    // is structurally assignable.
    if (e.kind === "member" && e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
      return `currentUser.${e.member}`;
    }
    void ctx;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capability filters (`filter <expr>` → AggregateIR.contextFilters).
//
// EF Core installs these once via `HasQueryFilter` and applies them to
// every query automatically.  Drizzle has no global query filter, so the
// generated repository must AND each predicate into every root-table read
// site (findById / findManyByIds / find* / view finds).  Principal-
// referencing filters (tenancy: `currentUser.tenantId`) are deferred —
// the IR validator (`validatePrincipalContextFilterSupport`) rejects them
// on Hono — so only non-principal predicates reach codegen here.
// ---------------------------------------------------------------------------

/** The non-principal capability-filter predicates for an aggregate, in
 *  declaration order.  Principal-referencing predicates are filtered out
 *  (the validator has already rejected them on Hono), so what remains
 *  always lowers to a closed Drizzle expression. */
export function nonPrincipalContextFilters(agg: EnrichedAggregateIR): ExprIR[] {
  return (agg.contextFilters ?? []).filter((p) => !exprUsesCurrentUser(p));
}

/** Lower an aggregate's capability filters to a single Drizzle predicate
 *  string (conjoined with `and(...)` when there is more than one), or
 *  null when the aggregate has none.  Adds the Drizzle ops it uses to
 *  `ops` so the import-narrowing in the repository builders pulls them
 *  in.  Returns null (rather than throwing) on a non-lowerable predicate
 *  — the validator guarantees selectability, so that path is unreachable
 *  for valid models. */
export function contextFilterPredicate(
  agg: EnrichedAggregateIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
  ops: Set<string>,
): string | null {
  const predicates = nonPrincipalContextFilters(agg);
  if (predicates.length === 0) return null;
  const lowered: string[] = [];
  for (const p of predicates) {
    const l = lowerToDrizzle(p, tableName, ctx);
    if (!l) return null;
    for (const op of l.ops) ops.add(op);
    lowered.push(l.expr);
  }
  if (lowered.length === 1) return lowered[0]!;
  ops.add("and");
  return `and(${lowered.join(", ")})`;
}

/** Combine a capability-filter predicate with an existing read predicate.
 *  `existing` is a raw Drizzle predicate expression (the argument that
 *  would go inside `.where(...)`), e.g. `eq(schema.docs.id, id)`.  When a
 *  capability filter is present both are wrapped in `and(...)`.  `and` is
 *  always in the repository's default Drizzle-op set, and the filter
 *  predicate's own ops were collected when it was lowered, so no ops set
 *  is threaded here — the import narrower keys off the emitted body. */
export function combinePredicate(existing: string, filterPred: string | null): string {
  if (!filterPred) return existing;
  return `and(${existing}, ${filterPred})`;
}
