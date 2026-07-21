// ---------------------------------------------------------------------------
// Java capability-filter triage — the "pay for what you use" hybrid for
// selective filter bypass (`ignoring <Cap>` / `ignoring *`,
// capability-emission-dedup.md §11.6).
//
// Java installs a NON-PRINCIPAL `filter <expr>` capability via Hibernate's
// `@SQLRestriction` — a STATIC always-on WHERE fragment on the entity, applied
// to every SELECT (the HasQueryFilter analog).  `@SQLRestriction` is unbypassable
// by design (Hibernate javadoc: "always applied and cannot be disabled"), so a
// capability some read `ignoring`s cannot stay there.  The idiomatic resolution
// is to TRIAGE each capability
// per aggregate at codegen:
//
//   - A capability NEVER bypassed on an aggregate stays in `@SQLRestriction`
//     (always-on, zero cost, zero change — covers JPQL + by-id + lazy).
//   - A capability that IS bypassed by some read is PROMOTED: its predicate(s)
//     are REMOVED from `@SQLRestriction` and emitted as a bypassable Hibernate
//     named filter (`@FilterDef(name=X, autoEnabled = true, applyToLoadByKey =
//     true)` + `@Filter(name=X, condition=<sql>)`).  `autoEnabled` reproduces
//     the always-on semantics with no interceptor; `applyToLoadByKey` keeps
//     by-id/lazy loads filtered.  At a bypassing read the repository impl wraps
//     the query body with `session.disableFilter(X)` / `enableFilter(X)`.
//   - A bare (non-capability, `contextFilterOrigins[i] === undefined`) filter is
//     NEVER bypassable, so it stays in `@SQLRestriction` always.
//
// PRINCIPAL (tenancy) filters are excluded from this module: they can't ride
// `@SQLRestriction` (no static principal), so they are AND-ed into the per-query
// JPQL in `emit/repository.ts`; their bypass is handled there by omitting the
// conjunct (exactly like node), keyed on `contextFilterOrigins`.
//
// The triage is a DERIVED fact (read-decls × `contextFilterOrigins`), computed
// here at codegen — never stamped on the IR.  The bypass SET (capability names)
// rides the IR (`FindIR`/the `repo-run` stmt); the predicate identity
// is derived in this emitter.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isQueryTimeProjection } from "../../ir/types/loom-ir.js";
import { renderSqlRestriction } from "./render-sql-restriction.js";

/** A read's capability filter-bypass spec (`ignoring <Cap>` / `ignoring *`),
 *  carried by capability NAME on `FindIR` / the repo-run stmt.
 *  Named caps match `AggregateIR.contextFilterOrigins`; a filter with an
 *  `undefined` origin (bare/hand-written) is never bypassable. */
export interface FilterBypass {
  bypassAll?: boolean;
  bypassCaps?: string[];
}

/** True when the capability named `cap` is dropped by `bypass`
 *  (`ignoring *` drops every capability filter; a named `ignoring <Cap>`
 *  drops only the matching capability). */
export function bypassDrops(cap: string, bypass: FilterBypass | undefined): boolean {
  if (!bypass) return false;
  if (bypass.bypassAll) return true;
  return (bypass.bypassCaps ?? []).includes(cap);
}

/** The distinct NON-PRINCIPAL capability names that contribute a filter to
 *  `agg` (its `contextFilterOrigins`, minus the `undefined` bare-filter slots
 *  and any principal-referencing predicate).  A capability appears once even if
 *  it contributes several filters.  Principal filters are excluded — they ride
 *  the repository's per-query JPQL, not `@SQLRestriction`. */
function nonPrincipalCapabilityOrigins(agg: AggregateIR): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const filters = agg.contextFilters ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  filters.forEach((pred, i) => {
    const o = origins[i];
    if (o == null || exprUsesCurrentUser(pred)) return;
    if (!seen.has(o)) {
      seen.add(o);
      out.push(o);
    }
  });
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

/** Every `ignoring`-bearing read of `agg` in `ctx` — repository finds, views
 *  over the aggregate, and inline repo-runs in workflow bodies — as a list of
 *  bypass specs. */
function bypassesForAggregate(agg: AggregateIR, ctx: BoundedContextIR): FilterBypass[] {
  const bypasses: FilterBypass[] = [];
  for (const repo of ctx.repositories) {
    if (repo.aggregateName !== agg.name) continue;
    for (const f of repo.finds) {
      if (f.bypassAll || (f.bypassCaps?.length ?? 0) > 0) {
        bypasses.push({ bypassAll: f.bypassAll, bypassCaps: f.bypassCaps });
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
  // A query-time projection's `ignoring` bypasses its `from` source aggregate's
  // filters through the synthesised source find — so it PROMOTES the cap too.
  for (const p of ctx.projections ?? []) {
    const q = p.query;
    if (!isQueryTimeProjection(p) || q?.source !== agg.name) continue;
    if (q.bypassAll || (q.bypassCaps?.length ?? 0) > 0) {
      bypasses.push({ bypassAll: q.bypassAll, bypassCaps: q.bypassCaps });
    }
  }
  return bypasses;
}

/** The NON-PRINCIPAL capabilities PROMOTED on `agg` — those a `find` /
 *  inline `Repo.run` read in the context bypasses (its `bypassCaps` names the
 *  cap, or `bypassAll`).  This is the §11.6 triage: a promoted capability leaves
 *  the always-on `@SQLRestriction` and is emitted as a bypassable `@Filter`
 *  instead.  Returns the promoted-cap NAMES (a subset of `agg`'s non-principal
 *  capability-filter origins), deduped and ordered by first contribution. */
export function promotedCapabilities(agg: AggregateIR, ctx: BoundedContextIR): string[] {
  const origins = nonPrincipalCapabilityOrigins(agg);
  if (origins.length === 0) return [];
  const bypasses = bypassesForAggregate(agg, ctx);
  return origins.filter((cap) => bypasses.some((b) => bypassDrops(cap, b)));
}

/** The non-principal capability-filter predicates that STAY in `@SQLRestriction`
 *  for `agg`: every non-principal predicate whose origin is NOT promoted (bare
 *  filters — `undefined` origin — always stay).  Index-aligned subset of
 *  `agg.contextFilters`. */
export function sqlRestrictionFilters(
  agg: EnrichedAggregateIR,
  promoted: ReadonlySet<string>,
): ExprIR[] {
  const filters = agg.contextFilters ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  return filters.filter((pred, i) => {
    if (exprUsesCurrentUser(pred)) return false;
    const o = origins[i];
    return o == null || !promoted.has(o);
  });
}

/** A promoted capability paired with its static SQL `condition` for the
 *  `@FilterDef`/`@Filter` pair.  Multiple predicates contributed by one cap are
 *  AND-ed into a single condition (same join `@SQLRestriction` uses). */
export interface PromotedFilter {
  cap: string;
  condition: string;
}

/** The PROMOTED capabilities' filter conditions for `agg`, one per cap, in
 *  declaration order.  Each condition is a constant SQL fragment (reusing the
 *  `@SQLRestriction` renderer) — parameterless (the validator gates the
 *  non-relational / principal shapes off java), so no `@ParamDef`/resolver is
 *  needed.  A cap contributing several predicates conjoins them with ` and `. */
export function promotedFilters(
  agg: EnrichedAggregateIR,
  promoted: ReadonlySet<string>,
): PromotedFilter[] {
  if (promoted.size === 0) return [];
  const filters = agg.contextFilters ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  const byCap = new Map<string, string[]>();
  filters.forEach((pred, i) => {
    if (exprUsesCurrentUser(pred)) return;
    const o = origins[i];
    if (o == null || !promoted.has(o)) return;
    const list = byCap.get(o) ?? [];
    list.push(renderSqlRestriction(pred));
    byCap.set(o, list);
  });
  const out: PromotedFilter[] = [];
  for (const [cap, conds] of byCap) {
    out.push({ cap, condition: conds.join(" and ") });
  }
  return out;
}

/** The PROMOTED capabilities a read's `bypass` actually drops on `agg` — the
 *  intersection of `promoted` with what `bypass` names (`ignoring *` drops them
 *  all; a named `ignoring X` drops the matching cap).  Returns the cap names in
 *  `promoted` iteration order, so the disableFilter sequence is deterministic.
 *  Empty when the read carries no `ignoring` clause or names only non-promoted
 *  caps (a principal cap, or one that stays in @SQLRestriction). */
export function bypassedPromotedCaps(
  promoted: ReadonlySet<string>,
  bypass: FilterBypass | undefined,
): string[] {
  if (promoted.size === 0 || !bypass) return [];
  return [...promoted].filter((cap) => bypassDrops(cap, bypass));
}

/** The UNION bypass spec per retrieval name, drawn from the inline
 *  `Repo.run(<Retrieval>(…)) ignoring …` call-sites in `ctx`'s workflows that
 *  hit `aggName`.  A retrieval's `run<Name>` impl method is SHARED across
 *  call-sites, so its disable set must cover EVERY site's bypass: `bypassAll` if
 *  any site bypasses all, else the union of the named caps.  Empty map when no
 *  inline read of `aggName` carries an `ignoring` clause. */
export function inlineRunBypassesByRetrieval(
  ctx: BoundedContextIR,
  aggName: string,
): Map<string, FilterBypass> {
  const runs: { aggName: string; bypass: FilterBypass; retrievalName?: string }[] = [];
  const collect = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      if (s.kind === "repo-run" && (s.bypassAll || (s.bypassCaps?.length ?? 0) > 0)) {
        runs.push({
          aggName: s.aggName,
          bypass: { bypassAll: s.bypassAll, bypassCaps: s.bypassCaps },
          retrievalName: s.retrievalName,
        });
      }
      if (s.kind === "for-each") collect(s.body);
      if (s.kind === "if-let") {
        collect(s.thenBody);
        collect(s.elseBody ?? []);
      }
    }
  };
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) collect(c.statements);
    for (const h of wf.handlers ?? []) collect(h.statements);
    for (const on of wf.subscriptions ?? []) collect(on.statements);
  }
  const acc = new Map<string, { bypassAll: boolean; caps: Set<string> }>();
  for (const r of runs) {
    if (r.aggName !== aggName || !r.retrievalName) continue;
    const cur = acc.get(r.retrievalName) ?? { bypassAll: false, caps: new Set<string>() };
    if (r.bypass.bypassAll) cur.bypassAll = true;
    for (const c of r.bypass.bypassCaps ?? []) cur.caps.add(c);
    acc.set(r.retrievalName, cur);
  }
  const out = new Map<string, FilterBypass>();
  for (const [name, v] of acc) {
    out.set(name, v.bypassAll ? { bypassAll: true } : { bypassCaps: [...v.caps] });
  }
  return out;
}

/** Wrap a repository-impl read body in `session.disableFilter`/`enableFilter`
 *  for the promoted capabilities `caps` (the §11.6 bypass site).  The body is a
 *  single statement — `return jpa.<method>(...);` — that must run with those
 *  Hibernate named filters DISABLED, then the filters are RE-ARMED in a
 *  `finally` so the rest of the session keeps the always-on semantics.  When
 *  `caps` is empty the body is returned unwrapped.  Indentation: the caller's
 *  body lines are already indented to the method-body level (8 spaces). */
export function wrapWithFilterBypass(caps: readonly string[], bodyLines: string[]): string[] {
  if (caps.length === 0) return bodyLines;
  const disables = caps.map((c) => `        __session.disableFilter(${JSON.stringify(c)});`);
  const enables = caps.map((c) => `            __session.enableFilter(${JSON.stringify(c)});`);
  return [
    `        var __session = em.unwrap(org.hibernate.Session.class);`,
    ...disables,
    `        try {`,
    ...bodyLines.map((l) => `    ${l}`),
    `        } finally {`,
    ...enables,
    `        }`,
  ];
}
