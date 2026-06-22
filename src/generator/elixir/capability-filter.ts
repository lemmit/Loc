// ---------------------------------------------------------------------------
// Ash capability-filter triage — the "pay for what you use" hybrid for
// selective filter bypass (`ignoring <Cap>` / `ignoring *`,
// named-filter-bypass.md §11.6).
//
// The Ash foundation installs a `filter <expr>` capability via the resource
// `base_filter`, which is ALWAYS-ON in Ash 3.x with NO per-query skip — so a
// `base_filter` predicate cannot be bypassed on a single read.  The idiomatic
// resolution (same shape as the Java §11.6 plan) is to TRIAGE each capability
// per aggregate at codegen:
//
//   - A capability NEVER bypassed on an aggregate stays in `base_filter`
//     (always-on, zero cost, zero change).
//   - A capability that IS bypassed by some read is PROMOTED: its predicate is
//     REMOVED from `base_filter` and applied PER-READ via `filter expr(...)` on
//     every generated read of that aggregate, OMITTED only on the reads that
//     `ignoring` it (or `ignoring *`).
//   - A bare (non-capability, `contextFilterOrigins[i] === undefined`) filter is
//     NEVER bypassable, so it stays in `base_filter` always.
//
// The triage is a DERIVED fact (read-decls × `contextFilterOrigins`), computed
// here at codegen — never stamped on the IR.  The bypass SET (capability names)
// rides the IR (`FindIR`/`ViewIR`/the `repo-run` stmt); the predicate identity
// is derived in this emitter.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";
import type { RenderCtx } from "./render-expr.js";
import { renderExpr } from "./render-expr.js";
import { criterionCalcName, reifiedCriterionForRef } from "./repository-emit.js";

/** A read's capability filter-bypass spec (`ignoring <Cap>` / `ignoring *`),
 *  carried by capability NAME on `FindIR` / `ViewIR` / the repo-run stmt.
 *  Named caps match `AggregateIR.contextFilterOrigins`; a filter with an
 *  `undefined` origin (bare/hand-written) is never bypassable. */
export interface FilterBypass {
  bypassAll?: boolean;
  bypassCaps?: string[];
}

/** True when the capability named `cap` is dropped by `bypass`
 *  (`ignoring *` drops every capability filter; a named `ignoring <Cap>`
 *  drops only the matching capability). */
function bypassDrops(cap: string, bypass: FilterBypass | undefined): boolean {
  if (!bypass) return false;
  if (bypass.bypassAll) return true;
  return (bypass.bypassCaps ?? []).includes(cap);
}

/** The distinct capability names that contribute a `base_filter` predicate to
 *  `agg` (its `contextFilterOrigins`, minus the `undefined` bare-filter slots).
 *  A capability appears once even if it contributes several filters. */
function capabilityOriginsOf(agg: AggregateIR): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of agg.contextFilterOrigins ?? []) {
    if (o != null && !seen.has(o)) {
      seen.add(o);
      out.push(o);
    }
  }
  return out;
}

/** Collect the `ignoring`-bearing inline `Repo.findAll`/`run` reads in a
 *  workflow-statement body (descends into `for-each` + `if-let` bodies),
 *  pairing each bypass spec with the aggregate it targets. */
function collectRepoRunBypasses(
  stmts: readonly WorkflowStmtIR[],
  out: { aggName: string; bypass: FilterBypass }[],
): void {
  for (const s of stmts) {
    if (s.kind === "repo-run" && (s.bypassAll || (s.bypassCaps?.length ?? 0) > 0)) {
      out.push({
        aggName: s.aggName,
        bypass: { bypassAll: s.bypassAll, bypassCaps: s.bypassCaps },
      });
    }
    if (s.kind === "for-each") collectRepoRunBypasses(s.body, out);
    if (s.kind === "if-let") {
      collectRepoRunBypasses(s.thenBody, out);
      collectRepoRunBypasses(s.elseBody ?? [], out);
    }
  }
}

/** The capabilities PROMOTED on `agg` — those a `find` / `view` / inline
 *  `Repo.run` read in the context bypasses (its `bypassCaps` names the cap, or
 *  `bypassAll`).  This is the §11.6 triage: a promoted capability leaves the
 *  always-on `base_filter` and is applied per-read instead.  Returns the
 *  promoted-cap NAMES (a subset of `agg`'s capability-filter origins), deduped
 *  and ordered by first contribution. */
export function promotedCapabilities(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const origins = capabilityOriginsOf(agg);
  if (origins.length === 0) return [];
  // Every read of `agg` in the context that carries a bypass clause.
  const bypasses: FilterBypass[] = [];
  for (const repo of ctx.repositories) {
    if (repo.aggregateName !== agg.name) continue;
    for (const f of repo.finds) {
      if (f.bypassAll || (f.bypassCaps?.length ?? 0) > 0) {
        bypasses.push({ bypassAll: f.bypassAll, bypassCaps: f.bypassCaps });
      }
    }
  }
  for (const v of ctx.views) {
    if (v.source.kind === "aggregate" && v.source.name === agg.name) {
      if (v.bypassAll || (v.bypassCaps?.length ?? 0) > 0) {
        bypasses.push({ bypassAll: v.bypassAll, bypassCaps: v.bypassCaps });
      }
    }
  }
  const repoRuns: { aggName: string; bypass: FilterBypass }[] = [];
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) collectRepoRunBypasses(c.statements, repoRuns);
    for (const h of wf.handlers ?? []) collectRepoRunBypasses(h.statements, repoRuns);
    for (const on of wf.subscriptions ?? []) collectRepoRunBypasses(on.statements, repoRuns);
  }
  for (const r of repoRuns) {
    if (r.aggName === agg.name) bypasses.push(r.bypass);
  }
  // A capability is promoted iff SOME read bypasses it.
  return origins.filter((cap) => bypasses.some((b) => bypassDrops(cap, b)));
}

/** One capability filter predicate, rendered as a bare-attribute Ash filter
 *  expression body (the `record.` receiver stripped — same convention as
 *  `renderBaseFilter`), paired with its capability origin name.  A reified
 *  criterion renders to its boolean calculation reference; everything else
 *  inlines.  Principal-referencing filters are excluded (the IR validator gates
 *  them off Phoenix) — what remains renders to a closed Ash expression. */
function renderCapabilityFilterPart(
  predicate: ExprIR,
  ref: { name: string; args: ExprIR[] } | undefined,
  ctx: RenderCtx,
  bctx: BoundedContextIR,
): string {
  // A filter that is exactly one named `criterion` reifies to its boolean
  // calculation reference (the calc body IS the predicate — behaviour-identical
  // to inlining).  Mirrors renderBaseFilter / the find/retrieval use-site.
  const reified = ref ? reifiedCriterionForRef(ref, bctx) : undefined;
  if (reified) {
    const callArgs = reified.params.map((param, j) => {
      const val = renderExpr(ref!.args[j]!, {
        ...ctx,
        thisName: "record",
        filterArgs: true,
      }).replace(/\brecord\./g, "");
      return `${snake(param.name)}: ${val}`;
    });
    return callArgs.length === 0
      ? criterionCalcName(reified.name)
      : `${criterionCalcName(reified.name)}(${callArgs.join(", ")})`;
  }
  return renderExpr(predicate, { ...ctx, thisName: "record" }).replace(/\brecord\./g, "");
}

/** The promoted capabilities' filter predicates for an aggregate, paired with
 *  the cap name, in `contextFilters` declaration order.  Each entry is a
 *  ready-to-splice Ash filter expression body (no `expr(...)` wrapper).  Only
 *  capability-origin filters whose cap is in `promoted` are returned; bare
 *  filters and non-promoted caps stay in `base_filter` and are excluded here.
 *
 *  Principal-referencing predicates are skipped (gated off elixir upstream). */
export function promotedFilterParts(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  promoted: ReadonlySet<string>,
): { cap: string; pred: string }[] {
  if (promoted.size === 0) return [];
  const refs = agg.contextFilterRefs ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  const out: { cap: string; pred: string }[] = [];
  (agg.contextFilters ?? []).forEach((predicate, i) => {
    const cap = origins[i];
    if (cap == null || !promoted.has(cap)) return;
    if (exprUsesCurrentUser(predicate)) return;
    out.push({ cap, pred: renderCapabilityFilterPart(predicate, refs[i], renderCtx, ctx) });
  });
  return out;
}

/** The Ash filter expression body that a read of `agg` must apply for the
 *  promoted capabilities, MINUS the ones this read bypasses — or null when
 *  there is nothing to apply (no promoted caps, or this read bypasses them
 *  all).  Predicates are conjoined with the infix `and` (a reserved word in
 *  Elixir — the function form is a SyntaxError), each parenthesised so an inner
 *  low-precedence operator can't bind across the join.  The caller splices the
 *  result into the read action as `filter expr(<body>)` (or AND-s it with the
 *  read's own `where`). */
export function promotedReadFilter(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  promoted: ReadonlySet<string>,
  bypass?: FilterBypass,
): string | null {
  const parts = promotedFilterParts(agg, ctx, renderCtx, promoted)
    .filter((p) => !bypassDrops(p.cap, bypass))
    .map((p) => p.pred);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" and ");
}

/** Conjoin a promoted-capability filter body with a read's own filter body.
 *  Either side may be null.  Both are parenthesised before joining with the
 *  infix `and` so inner operators stay scoped. */
export function combineAshFilter(own: string | null, promoted: string | null): string | null {
  if (!promoted) return own;
  if (!own) return promoted;
  return `(${own}) and (${promoted})`;
}
