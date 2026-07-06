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
  CriterionIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../ir/util/ref-collection.js";
import {
  DATA_KEY_PATH_DELIMITER,
  deepScopeAnchorClaim,
  isDeepScopeFilter,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
import { lowerFirst, plural } from "../../util/naming.js";
import { joinColumnName, joinTableConstName } from "./emit.js";
import { TS_INTRINSIC_RENDERERS } from "./render-expr.js";
import { associationsOf } from "./repository-associations-builder.js";

// SQL-side scalar-intrinsic snippets (src/util/intrinsics.ts) — how a
// `queryable` intrinsic applied to a COLUMN renders inside a Drizzle
// predicate.  The snippet receives the already-rendered column ref (and
// rendered value args) and yields a `sql\`…\`` wrapper Drizzle accepts in
// operator position; callers add `sql` to the import set.  Value-side
// intrinsic applications (a param receiver) render through the plain TS
// snippet table instead — the value side is host-language JS.  Exported
// for the intrinsic completeness test.
export const DRIZZLE_INTRINSIC_SQL: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `sql\`trim(\${${recv}})\``,
  "string.toUpper": (recv) => `sql\`upper(\${${recv}})\``,
  "string.toLower": (recv) => `sql\`lower(\${${recv}})\``,
  // Numerics (A3) — int/long map to integer/bigint columns, decimal/money
  // both to `numeric`, so the same Postgres function applies per op.
  // `round(numeric, n)` is half-away-from-zero on Postgres, matching the
  // catalogue contract; LEAST/GREATEST are the two-value forms.
  "int.abs": (recv) => `sql\`abs(\${${recv}})\``,
  "long.abs": (recv) => `sql\`abs(\${${recv}})\``,
  "decimal.abs": (recv) => `sql\`abs(\${${recv}})\``,
  "money.abs": (recv) => `sql\`abs(\${${recv}})\``,
  "int.min": (recv, args) => `sql\`least(\${${recv}}, \${${args[0]}})\``,
  "long.min": (recv, args) => `sql\`least(\${${recv}}, \${${args[0]}})\``,
  "decimal.min": (recv, args) => `sql\`least(\${${recv}}, \${${args[0]}})\``,
  "money.min": (recv, args) => `sql\`least(\${${recv}}, \${${args[0]}})\``,
  "int.max": (recv, args) => `sql\`greatest(\${${recv}}, \${${args[0]}})\``,
  "long.max": (recv, args) => `sql\`greatest(\${${recv}}, \${${args[0]}})\``,
  "decimal.max": (recv, args) => `sql\`greatest(\${${recv}}, \${${args[0]}})\``,
  "money.max": (recv, args) => `sql\`greatest(\${${recv}}, \${${args[0]}})\``,
  "decimal.round": (recv, args) =>
    args.length > 0 ? `sql\`round(\${${recv}}, \${${args[0]}})\`` : `sql\`round(\${${recv}})\``,
  "money.round": (recv, args) =>
    args.length > 0 ? `sql\`round(\${${recv}}, \${${args[0]}})\`` : `sql\`round(\${${recv}})\``,
  "decimal.floor": (recv) => `sql\`floor(\${${recv}})\``,
  "money.floor": (recv) => `sql\`floor(\${${recv}})\``,
  "decimal.ceil": (recv) => `sql\`ceil(\${${recv}})\``,
  "money.ceil": (recv) => `sql\`ceil(\${${recv}})\``,
};

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
  opts?: {
    /** How a `currentUser.<field>` reference renders.  Defaults to the bare
     *  `currentUser` parameter (the per-find `where` path threads it in).  The
     *  always-on capability-filter path passes `"requireCurrentUser()"` — the
     *  ambient principal accessor — so no read method needs a `currentUser`
     *  parameter (DEBT-01; the Drizzle analogue of EF Core reading
     *  `RequestContext.Current` inside `HasQueryFilter`). */
    principalAccessor?: string;
  },
): DrizzleLowering | null {
  const principal = opts?.principalAccessor ?? "currentUser";
  const ops = new Set<string>();
  const text = lowerExpr(expr);
  if (text === null) return null;
  return { expr: text, ops };

  function lowerExpr(e: ExprIR): string | null {
    if (e.kind === "paren") return lowerExpr(e.inner);
    // `deep` read level (multi-tenancy Phase 2 P2.4) — the materialized-path
    // descendant-or-self scope with the NULL-dataKey fallback to the tenant
    // floor (see `DEEP_SCOPE_SEMANTICS`).  Renders as a Drizzle operator tree.
    if (isDeepScopeFilter(e)) {
      const col = `schema.${tableName}.${TENANT_OWNED_DATA_KEY_FIELD}`;
      const tenantCol = `schema.${tableName}.${TENANT_OWNED_TENANT_ID_FIELD}`;
      // Anchor claim off `args[0]`: `orgPath` for `deep`, `rootOrg` for `global`.
      const org = `${principal}.${deepScopeAnchorClaim(e)}`;
      const tenant = `${principal}.${TENANT_OWNED_TENANT_ID_FIELD}`;
      for (const op of ["or", "and", "eq", "isNull", "isNotNull", "like"]) ops.add(op);
      return (
        `or(and(isNotNull(${col}), or(eq(${col}, ${org}), ` +
        `like(${col}, ${org} + ${JSON.stringify(`${DATA_KEY_PATH_DELIMITER}%`)}))), ` +
        `and(isNull(${col}), eq(${tenantCol}, ${tenant})))`
      );
    }
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
    // Queryable scalar intrinsic over a column — `this.name.trim()` —
    // wraps the column ref in its SQL snippet (`sql\`trim(col)\``).
    if (e.kind === "method-call" && e.receiverType.kind === "primitive") {
      const sig = intrinsicFor(e.receiverType.name, e.member);
      const sqlSnippet = DRIZZLE_INTRINSIC_SQL[intrinsicKey(e.receiverType.name, e.member)];
      if (sig?.queryable && sqlSnippet) {
        const col = renderColumnRef(e.receiver);
        // An intrinsic ARG may itself be a column (`this.a.min(this.b)` →
        // `least(a, b)`) — values bind as params, columns interpolate, so
        // both render fine inside the sql tag.
        const args = e.args.map((a) => renderValue(a) ?? renderColumnRef(a));
        if (col === null || args.some((a) => a === null)) return null;
        ops.add("sql");
        return sqlSnippet(col, args as string[]);
      }
      return null;
    }
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
      return `${principal}.${e.member}`;
    }
    // Queryable scalar intrinsic over a VALUE (a param/let receiver —
    // `q.trim()`): the value side of a Drizzle comparison is plain JS,
    // so render through the TS in-memory snippet table.  If an ARG is
    // itself a column (`q.min(this.cap)`), plain JS can't express it —
    // fall over to the SQL snippet instead (the param receiver binds as
    // a parameter inside the sql tag, the column interpolates).
    if (e.kind === "method-call" && e.receiverType.kind === "primitive") {
      const sig = intrinsicFor(e.receiverType.name, e.member);
      const key = intrinsicKey(e.receiverType.name, e.member);
      const tsSnippet = TS_INTRINSIC_RENDERERS[key];
      const sqlSnippet = DRIZZLE_INTRINSIC_SQL[key];
      if (sig?.queryable && tsSnippet) {
        const recv = renderValue(e.receiver);
        if (recv === null) return null;
        const plainArgs = e.args.map((a) => renderValue(a));
        if (plainArgs.every((a) => a !== null)) {
          return tsSnippet(recv, plainArgs as string[]);
        }
        if (sqlSnippet) {
          const mixedArgs = e.args.map((a) => renderValue(a) ?? renderColumnRef(a));
          if (mixedArgs.some((a) => a === null)) return null;
          ops.add("sql");
          return sqlSnippet(recv, mixedArgs as string[]);
        }
        return null;
      }
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

/** Same set, paired with the per-entry `criterionRef` (index-aligned in the
 *  IR) so the predicate builder can reify a filter that is exactly one named
 *  criterion (reified-criteria.md, the anonymous-`filter` row). */
export function nonPrincipalContextFilterEntries(
  agg: EnrichedAggregateIR,
): { predicate: ExprIR; criterionRef?: { name: string; args: ExprIR[] } }[] {
  return (agg.contextFilters ?? [])
    .map((predicate, i) => ({ predicate, criterionRef: agg.contextFilterRefs?.[i] }))
    .filter((e) => !exprUsesCurrentUser(e.predicate));
}

/** A read's capability filter-bypass spec (`ignoring <Cap>` / `ignoring *`),
 *  carried index-by-name on `FindIR` / `ViewIR` / the repo-run stmt.  Named
 *  capabilities are matched against `AggregateIR.contextFilterOrigins`; a
 *  filter whose origin is `undefined` (hand-written/bare) is never bypassable
 *  — only capability-contributed filters can be `ignoring`-dropped. */
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

/** ALL capability-filter entries for an aggregate (principal-referencing
 *  included), index-aligned with their `criterionRef`.  A principal filter
 *  (`currentUser.tenantId`) renders to `currentUser.<field>` against the
 *  `currentUser: User` parameter the read method gains — see
 *  `aggregateUsesPrincipalContextFilter`.  (DEBT-01.)
 *
 *  When `bypass` is supplied (the read carried an `ignoring` clause), entries
 *  whose `contextFilterOrigins[i]` the bypass names are dropped from the
 *  conjunction — the capability's predicate is OMITTED for that read only. */
export function allContextFilterEntries(
  agg: EnrichedAggregateIR,
  bypass?: FilterBypass,
): { predicate: ExprIR; criterionRef?: { name: string; args: ExprIR[] } }[] {
  return (agg.contextFilters ?? [])
    .map((predicate, i) => ({
      predicate,
      criterionRef: agg.contextFilterRefs?.[i],
      origin: agg.contextFilterOrigins?.[i],
    }))
    .filter((e) => !isFilterBypassed(e.origin, bypass))
    .map(({ predicate, criterionRef }) => ({ predicate, criterionRef }));
}

// ---------------------------------------------------------------------------
// Reified criteria (reified-criteria.md) — the module-level predicate fn a
// `criterionRef` use-site (find / retrieval `where`, capability `filter`)
// calls instead of re-inlining the criterion's body.  The fn rendering
// itself (`renderCriterionFn`) lives in repository-find-builder.ts (it needs
// the TS param-type mapping); these three are the lower-layer pieces the
// capability-filter builder below shares with it.
// ---------------------------------------------------------------------------

/** Module-level fn name for a reified criterion (`inRegionCriterion`). */
export function criterionFnName(name: string): string {
  return `${lowerFirst(name)}Criterion`;
}

/** The criterion a use-site `criterionRef` reifies to — present in the context
 *  and with a Drizzle-lowerable body — or `undefined` (fall back to inline). */
export function reifiableCriterion(
  ref: { name: string; args: ExprIR[] } | undefined,
  ctx: EnrichedBoundedContextIR,
  tableName: string,
): CriterionIR | undefined {
  if (!ref) return undefined;
  const c = ctx.criteria.find((x) => x.name === ref.name);
  if (!c) return undefined;
  return lowerToDrizzle(c.body, tableName, ctx) ? c : undefined;
}

/** Render a criterion-call argument (the value passed at the use-site) — a
 *  parameter/let reference renders as its name, a literal as its value. */
export function renderCriterionArg(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "literal") return e.lit === "string" ? JSON.stringify(e.value) : e.value;
  // Criterion call args are values (param refs / literals) in v1.
  return "undefined as never";
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
  bypass?: FilterBypass,
): string | null {
  const entries = allContextFilterEntries(agg, bypass);
  if (entries.length === 0) return null;
  const lowered: string[] = [];
  for (const e of entries) {
    // A filter that is exactly one named criterion reifies: call the
    // module-level `<name>Criterion(...)` fn (emitted by
    // repository-builder, deduped with find/retrieval consumers) instead
    // of re-inlining the body.  Behaviour-identical — the fn body IS the
    // lowered predicate.  Its Drizzle ops still join the import walk.
    // A principal-referencing filter (`currentUser.x`) never reifies — the
    // module-level `<name>Criterion()` fn has no `currentUser` in scope — so
    // it always inlines (the inline render emits `currentUser.<field>`).
    const c = exprUsesCurrentUser(e.predicate)
      ? undefined
      : reifiableCriterion(e.criterionRef, ctx, tableName);
    if (c) {
      const body = lowerToDrizzle(c.body, tableName, ctx)!;
      for (const op of body.ops) ops.add(op);
      const args = (e.criterionRef?.args ?? []).map(renderCriterionArg).join(", ");
      lowered.push(`${criterionFnName(c.name)}(${args})`);
      continue;
    }
    // A principal-referencing filter renders its `currentUser.<field>` against
    // the ambient `requireCurrentUser()` accessor, so the read needs no
    // `currentUser` parameter (DEBT-01).
    const l = lowerToDrizzle(e.predicate, tableName, ctx, {
      principalAccessor: "requireCurrentUser()",
    });
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
