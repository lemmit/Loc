// -------------------------------------------------------------------------
// Query checks — `find` where-clause queryable-subset selectability and
// `retrieval` validation.
// -------------------------------------------------------------------------

import type { BoundedContextIR, EnrichedAggregateIR } from "../../types/loom-ir.js";
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
  // to the same queryable subset as a `find`/`view` `where`.  Until now
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
      const unknown = firstUnknownColumnRef(predicate, agg, ctx);
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
