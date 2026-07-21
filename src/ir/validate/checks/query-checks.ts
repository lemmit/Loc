// -------------------------------------------------------------------------
// Query checks — `find` where-clause queryable-subset selectability and
// `retrieval` validation.
// -------------------------------------------------------------------------

import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  RefKind,
} from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import {
  aggregateHasMember,
  firstColumnVsColumn,
  firstNonQueryableNode,
  firstUnknownColumnRef,
} from "./shared.js";

// ---------------------------------------------------------------------------
// QueryExpr enforcement.  Every repository `find` declared with a
// `where ...` clause must restrict that clause to the queryable
// expression sublanguage — comparisons, `&&`, `||`, `!`, parenthesised
// groups, and references to the aggregate root's columns / find
// parameters.  Anything richer (collection ops, lambdas, member
// access into parts, value-object constructors, calls) cannot lower
// to SQL, so the Drizzle backend would have had to skip it.  We
// reject these at the IR layer instead, with a message pointing the
// user at the supported subset.
// ---------------------------------------------------------------------------

export function validateQueryableWheres(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const repo of ctx.repositories) {
    const agg = ctx.aggregates.find((a) => a.name === repo.aggregateName);
    for (const find of repo.finds) {
      if (!find.filter) continue;
      const offending = firstNonQueryableNode(find.filter);
      if (offending) {
        diags.push({
          severity: "error",
          code: "loom.find-where-not-queryable",
          message:
            `repository '${repo.name}' find '${find.name}': ` +
            `where-clause is not queryable (${offending}). ` +
            `Allowed: comparisons, &&/||/!, parens, ` +
            `'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
        continue;
      }
      // Beyond grammar-level queryability: each `this.<X>` reference
      // must resolve to a real aggregate field.  Without this check
      // the generator emits SQL against a non-existent column and
      // the runtime fails (or silently returns nothing).
      if (agg) {
        const unknown = firstUnknownColumnRef(find.filter, agg, ctx);
        if (unknown) {
          diags.push({
            severity: "error",
            code: "loom.find-where-unknown-field",
            message:
              `repository '${repo.name}' find '${find.name}': ` +
              `where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
            source: `${ctx.name}/${repo.name}.${find.name}`,
          });
        }
      }
      // And: every binary comparison must compare ONE column against
      // ONE value (parameter, literal, enum-value).  Drizzle's
      // `eq(col, val)` doesn't model column-vs-column comparisons —
      // they'd need raw SQL.  Our generator errors out at lowering
      // when both sides are columns; rejecting at validation surfaces
      // the issue earlier and with a clearer message.
      const bothCols = firstColumnVsColumn(find.filter);
      if (bothCols) {
        diags.push({
          severity: "error",
          code: "loom.find-where-column-column",
          message:
            `repository '${repo.name}' find '${find.name}': ` +
            `comparison between two columns (${bothCols}) is not queryable. ` +
            `Drizzle's eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
    }
  }
  // `filter <expr>` capability predicates (lowered to
  // `agg.contextFilters`) are a SELECTION position too: every backend
  // installs them at the query layer (.NET `HasQueryFilter`, Drizzle
  // read-site conjunction, Ecto base-query helper), so they must lower
  // to the same queryable subset as a `find` `where`.  Until now
  // they bypassed this check — an unselectable capability filter would
  // silently emit nothing (Drizzle/Ecto) or fail at C# render (.NET).
  // `currentUser.<scalar>` is admitted here exactly as in find filters:
  // the backend threads the request principal in (row-level
  // soft-delete / tenancy filters are the motivating case).
  for (const agg of ctx.aggregates) {
    const filters = (agg as EnrichedAggregateIR).contextFilters ?? [];
    for (const predicate of filters) {
      const offending = firstNonQueryableNode(predicate);
      if (offending) {
        diags.push({
          severity: "error",
          message:
            `aggregate '${agg.name}': a 'filter' capability predicate is not selectable (${offending}). ` +
            `Capability filters install at the query layer, so they must lower to the queryable subset: ` +
            `comparisons, &&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, 'currentUser.<field>', literals.`,
          source: `${ctx.name}/${agg.name}`,
          code: "loom.criterion-not-selectable",
        });
        continue;
      }
      // `this.id` is admitted: a capability filter is aggregate-rooted, and
      // the key is a real stored column on every backend — the derived
      // tenancy registry self-scope (`this.id == currentUser.<claim>`,
      // Phase 1b) is exactly this shape.
      const unknown = firstUnknownColumnRef(predicate, agg, ctx, { allowSelfId: true });
      if (unknown) {
        diags.push({
          severity: "error",
          message: `aggregate '${agg.name}': a 'filter' capability predicate references unknown field ${unknown} on '${agg.name}'.`,
          source: `${ctx.name}/${agg.name}`,
          code: "loom.criterion-not-selectable",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Raw-seed column value gate (Bucket V / P4).  A `seed raw { … }` row is a
// direct Postgres INSERT (sql-pg.ts `renderSeedRowInsert` / `seedSqlLiteral`):
// each column value must be a scalar / enum / id literal — or `now()`.  Any
// other resolved expression (a member access, an arithmetic, a function call,
// a reference to another column) throws at generate time
// ("raw seed: unsupported column value of kind …").  We reject those at
// validation so the throw is unreachable from valid input.
//
// The allowed shapes mirror `seedSqlLiteral` exactly:
//   - any `literal` (string / int / long / decimal / money / bool / null /
//     now);
//   - an `enum-value` ref (`Status.Draft` → its stored text).
// Value-object / nested-record columns on a raw row are already rejected by
// the AST seed validator (`loom.seed-raw-unsupported-column`); this catches
// the remaining non-literal expressions that AST validator lets through.
// ---------------------------------------------------------------------------

/** True when a resolved seed column value is a Postgres literal the raw-seed
 *  INSERT renderer accepts (scalar / enum / id literal or `now()`). */
function isRawSeedLiteral(e: ExprIR): boolean {
  if (e.kind === "literal") return true;
  if (e.kind === "ref" && e.refKind === "enum-value") return true;
  return false;
}

export function validateRawSeedColumns(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const seed of ctx.seeds ?? []) {
    if (seed.path !== "raw") continue;
    for (const row of seed.rows) {
      for (const f of row.fields) {
        if (!isRawSeedLiteral(f.value)) {
          diags.push({
            severity: "error",
            code: "loom.seed-raw-non-literal-column",
            message:
              `seed raw '${row.aggregate}.${f.name}': a raw-seed column must be a scalar / enum / id ` +
              `literal (or 'now()'); the value '${describeSeedValue(f.value)}' is computed at ` +
              `generate time, which the direct-INSERT seed path can't render. ` +
              `Use a literal value, or the domain seed path ('seed { … }' without 'raw').`,
            source: `${ctx.name}/seed ${seed.dataset}`,
          });
        }
      }
    }
  }
}

/** A short label for a rejected (non-literal) raw-seed column value. */
function describeSeedValue(e: ExprIR): string {
  switch (e.kind) {
    case "ref":
      return `${e.name} (${e.refKind})`;
    case "member":
      return `member access '.${e.member}'`;
    case "method-call":
      return `call '.${e.member}(…)'`;
    case "call":
      return `call to '${e.name}'`;
    case "binary":
      return `'${e.op}' expression`;
    case "new":
      return `'new ${e.partName}'`;
    case "object":
      return "object literal";
    default:
      return e.kind;
  }
}

// ---------------------------------------------------------------------------
// Retrieval validation (retrieval.md).  A `retrieval`'s `where` is a
// selection position — same queryable-subset contract as a `find …
// where` (reuses the oracle above).  Its `sort` and `loads` slots carry
// structural paths that must resolve against the candidate aggregate.
// `page` cannot appear here (the grammar forbids a page slot), so there
// is nothing to check for it.
// ---------------------------------------------------------------------------

export function validateRetrievals(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const r of ctx.retrievals) {
    const targetName = r.targetType.kind === "entity" ? r.targetType.name : undefined;
    const agg = targetName ? ctx.aggregates.find((a) => a.name === targetName) : undefined;
    const src = `${ctx.name}/retrieval ${r.name}`;

    // `where` — same queryable-subset enforcement as find filters.
    const offending = firstNonQueryableNode(r.where);
    if (offending) {
      diags.push({
        severity: "error",
        code: "loom.retrieval-where-not-queryable",
        message:
          `retrieval '${r.name}': where-clause is not queryable (${offending}). ` +
          `Allowed: comparisons, &&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
        source: src,
      });
    } else if (agg) {
      const unknown = firstUnknownColumnRef(r.where, agg, ctx);
      if (unknown) {
        diags.push({
          severity: "error",
          code: "loom.retrieval-where-unknown-field",
          message: `retrieval '${r.name}': where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
          source: src,
        });
      }
      const bothCols = firstColumnVsColumn(r.where);
      if (bothCols) {
        diags.push({
          severity: "error",
          code: "loom.retrieval-where-column-column",
          message:
            `retrieval '${r.name}': comparison between two columns (${bothCols}) is not queryable. ` +
            `eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
          source: src,
        });
      }
    }

    if (!agg) continue;

    // `sort` — each term's path must start at a real aggregate field.
    for (const term of r.sort) {
      const head = term.path[0];
      if (head && !aggregateHasMember(agg, head.name)) {
        diags.push({
          severity: "error",
          code: "loom.retrieval-sort-unknown-field",
          message: `retrieval '${r.name}': sort references unknown field '${head.name}' on aggregate '${agg.name}'.`,
          source: src,
        });
      }
    }

    // `loads` — explicit eager-load specs are not supported yet.  Every
    // retrieval loads the *whole* aggregate (all owned containments).  The
    // planned replacement is per-operation autoload: derive the load set
    // from the expressions an operation's body uses, so it's sufficient by
    // construction (no `loads`-sufficiency validator needed).  Until then a
    // narrowing `loads:` would silently under-fetch on Phoenix (a
    // `%NotLoaded{}` crash in a downstream for-loop op) while being inert
    // on Hono/.NET (owned parts always materialise) — so it is rejected
    // outright rather than honoured inconsistently across backends.  See
    // load-specifications.md.
    if (r.loadPlan.kind === "explicit") {
      diags.push({
        severity: "error",
        code: "loom.retrieval-loads-unsupported",
        message:
          `retrieval '${r.name}': explicit 'loads:' is not supported yet — ` +
          `retrievals load the whole aggregate. (Per-operation autoload is planned.)`,
        source: src,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Read `requires` gate (D-AUTH-OIDC / default-deny).  A repository find's
// optional `requires <expr>` is an authorization gate evaluated against
// `currentUser` *before* the query runs — failure → 403.  Because no row exists
// at gate time, the gate may reference only `currentUser` (+ constants), never
// the source row.  Reject row-state references (this-prop / this-vo-prop /
// this-derived) with a message steering the author to `where` for row scoping.
// ---------------------------------------------------------------------------

// Allowlist (not denylist): the gate is lowered in the bare context env, so a
// source-field reference doesn't resolve to `this-prop` — it lowers to an
// `unknown` ref.  An allowlist catches that (and any future refKind): only
// `current-user`, `enum-value`, and internally-bound refs (`lambda` params,
// pure `helper-fn`s) are legal in a gate.
const GATE_ALLOWED_REFS: ReadonlySet<RefKind> = new Set<RefKind>([
  "current-user",
  "enum-value",
  "lambda",
  "helper-fn",
]);

// Find `requires` gate (D-AUTH-OIDC / default-deny).
// A repository find's optional `requires <expr>` runs before
// the query; because no row exists yet it may reference only `currentUser`
// (+ constants), never the source row.  Reject any source-row reference (which
// lowers to an `unknown` ref in the bare gate env).
export function validateFindGates(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const repo of ctx.repositories) {
    for (const find of repo.finds) {
      if (!find.requires) continue;
      const offending = firstNonGateRef(find.requires, GATE_ALLOWED_REFS);
      if (offending !== null) {
        diags.push({
          severity: "error",
          code: "loom.find-gate-not-current-user",
          message:
            `find '${repo.name}.${find.name}': a \`requires\` gate runs before the query (no row ` +
            `exists yet), so it may only reference \`currentUser\` (and constants) — \`${offending}\` ` +
            "is not available here. Use `where` to scope which rows return; use `requires` to " +
            "allow / deny the caller.",
          source: `find/${repo.name}.${find.name}`,
        });
      }
    }
  }
}

// Query-time projection `requires` gate — the projection twin of the find gate.
// A query-time projection's optional `requires <expr>` runs before the query;
// because no row exists yet it may reference only `currentUser` (+ constants),
// never the source row.  A gate on a projection with no query source has nothing
// to protect (the folded read model is keyed, not query-time), so reject that too.
export function validateProjectionGates(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const proj of ctx.projections) {
    const gate = proj.query?.requires;
    if (!gate) continue;
    if (!proj.query?.source) {
      diags.push({
        severity: "error",
        code: "loom.projection-gate-without-source",
        message:
          `projection '${proj.name}': a \`requires\` gate guards a query-time read, but this ` +
          "projection declares no `from` source. Add a `from <Aggregate>` clause, or drop the gate.",
        source: `projection/${proj.name}`,
      });
      continue;
    }
    const offending = firstNonGateRef(gate, GATE_ALLOWED_REFS);
    if (offending !== null) {
      diags.push({
        severity: "error",
        code: "loom.projection-gate-not-current-user",
        message:
          `projection '${proj.name}': a \`requires\` gate runs before the query (no row exists ` +
          `yet), so it may only reference \`currentUser\` (and constants) — \`${offending}\` is not ` +
          "available here. Use `where` to scope which rows return; use `requires` to allow / deny " +
          "the caller.",
        source: `projection/${proj.name}`,
      });
    }
  }
}

/** The name of the first reference in an expression tree that isn't in the
 *  gate's `allowed` refKind set, or null when the expression touches only
 *  allowed refs / constants / operators. */
function firstNonGateRef(e: ExprIR, allowed: ReadonlySet<RefKind>): string | null {
  if (e.kind === "ref") return allowed.has(e.refKind) ? null : e.name;
  switch (e.kind) {
    case "member":
      return firstNonGateRef(e.receiver, allowed);
    case "method-call":
      return firstNonGateRef(e.receiver, allowed) ?? firstFromArgs(e.args, allowed);
    case "call":
      return firstFromArgs(e.args, allowed);
    case "binary":
      return firstNonGateRef(e.left, allowed) ?? firstNonGateRef(e.right, allowed);
    case "ternary":
      return (
        firstNonGateRef(e.cond, allowed) ??
        firstNonGateRef(e.then, allowed) ??
        firstNonGateRef(e.otherwise, allowed)
      );
    case "unary":
      return firstNonGateRef(e.operand, allowed);
    case "paren":
      return firstNonGateRef(e.inner, allowed);
    case "convert":
      return firstNonGateRef(e.value, allowed);
    case "list":
      return firstFromArgs(e.elements, allowed);
    case "match":
      return (
        firstFromArgs(
          e.arms.flatMap((a) => [a.cond, a.value]),
          allowed,
        ) ?? (e.otherwise ? firstNonGateRef(e.otherwise, allowed) : null)
      );
    case "lambda":
      return e.body ? firstNonGateRef(e.body, allowed) : null;
    case "new":
    case "object":
      return firstFromArgs(
        e.fields.map((f) => f.value),
        allowed,
      );
    default:
      return null;
  }
}

function firstFromArgs(args: ExprIR[], allowed: ReadonlySet<RefKind>): string | null {
  for (const a of args) {
    const r = firstNonGateRef(a, allowed);
    if (r !== null) return r;
  }
  return null;
}
