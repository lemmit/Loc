// ---------------------------------------------------------------------------
// Vanilla capability-filter helper.
//
// A `filter <expr>` capability (`contextFilters` on the aggregate) must be
// AND-ed into EVERY root read of the aggregate.  Plain Ecto has no global
// query filter, so the generated repository / retrieval / view modules must
// conjoin each predicate into every `from(record in <Agg>, where: …)` read site —
// exactly the Hono/Drizzle situation (half-applying a soft-delete filter would
// be a correctness hole).
//
// Predicates render under the `record` Ecto binding (`!this.isDeleted` →
// `not record.is_deleted`).  A `filter <Criterion>` reference inlines its
// predicate directly.
//
// **Principal (tenancy) filters** (`this.tenantId == currentUser.tenantId`) are
// emitted only when the caller threads the request actor (`{ actor: true }`).
// `currentUser.tenantId` lowers to `current_user.tenant_id`; inside an Ecto
// `where:` the principal side must be PINNED, and it must stay fail-closed when
// no actor is present (an unauthenticated / workflow-internal read), so it
// renders as `^(current_user && current_user.tenant_id)` — a pinned `nil` makes
// the comparison match no rows (Ecto binds `= NULL`, never `IS NULL`), giving an
// empty result.  Callers that pass `{ actor: true }` MUST bind a `current_user`
// variable in scope.
// ---------------------------------------------------------------------------

import type { AggregateIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { deepScopeAnchorClaim, isDeepScopeFilter } from "../../../ir/util/tenant-stance.js";
import { type RenderCtx, renderDeepScopeEcto, renderExpr } from "../render-expr.js";

export { aggregateUsesPrincipalContextFilter } from "../../../ir/types/loom-ir.js";

/** Rewrite a principal predicate's `current_user.<field>` accesses into the
 *  fail-closed pinned form for an Ecto `where:`.  No-op for non-principal
 *  predicates (they only touch `record.*`). */
function pinPrincipal(rendered: string): string {
  return rendered.replace(/\bcurrent_user\.([a-z0-9_]+)/g, "^(current_user && current_user.$1)");
}

/** A read's capability filter-bypass spec (`ignoring <Cap>` / `ignoring *`),
 *  carried by capability NAME on `FindIR` / `ViewIR` / the repo-run stmt.
 *  Named caps match `AggregateIR.contextFilterOrigins`; a filter with an
 *  `undefined` origin (bare/hand-written) is never bypassable. */
export interface FilterBypass {
  bypassAll?: boolean;
  bypassCaps?: string[];
}

/** True when the capability filter at origin index `i` is dropped by `bypass`
 *  (`ignoring *` drops every capability-origin filter; a named `ignoring <Cap>`
 *  drops only the matching origin; an `undefined` origin is never dropped). */
function isFilterBypassed(origin: string | undefined, bypass: FilterBypass | undefined): boolean {
  if (!bypass || origin === undefined) return false;
  if (bypass.bypassAll) return true;
  return (bypass.bypassCaps ?? []).includes(origin);
}

/** The aggregate's capability filters as a single Ecto predicate (conjoined
 *  with the infix `and`, each parenthesised), or null when it has none.
 *  `contextModule` feeds the shared `renderExpr` (enum / type vocab).
 *
 *  Without `{ actor: true }` only NON-principal predicates are emitted (the
 *  no-actor read sites — and the byte-identical default).  With `{ actor: true }`
 *  the principal predicates are included too, pinned against a `current_user`
 *  the caller must have threaded into scope.
 *
 *  When `opts.bypass` is supplied (the read carried an `ignoring` clause), the
 *  capability filters whose `contextFilterOrigins[i]` the bypass names are
 *  OMITTED from the conjunction — for that read only. */
export function vanillaCapabilityFilter(
  agg: AggregateIR,
  contextModule: string,
  opts?: { actor?: boolean; bypass?: FilterBypass },
): string | null {
  const ctx: RenderCtx = { thisName: "record", contextModule, foundation: "vanilla" };
  const preds = (agg.contextFilters ?? [])
    .filter((_, i) => !isFilterBypassed(agg.contextFilterOrigins?.[i], opts?.bypass))
    .filter((p) => opts?.actor || !exprUsesCurrentUser(p))
    .map((p) =>
      // The `deep` sentinel renders its own fail-closed pinned fragment — do
      // NOT run it through `pinPrincipal` (it already pins).
      isDeepScopeFilter(p)
        ? renderDeepScopeEcto(ctx.thisName, deepScopeAnchorClaim(p))
        : exprUsesCurrentUser(p)
          ? pinPrincipal(renderExpr(p, ctx))
          : renderExpr(p, ctx),
    );
  if (preds.length === 0) return null;
  // `and` is a reserved word in Elixir — the infix form is the only valid one
  // inside `where:`.  Parenthesise each so a low-precedence operator inside one
  // (`a or b`) can't bind across the join.
  return preds.length === 1 ? preds[0]! : preds.map((p) => `(${p})`).join(" and ");
}

/** Conjoin a capability-filter predicate with an existing `where:` predicate.
 *  Either side may be null (no existing filter / no capability filter). */
export function combineWhere(existing: string | null, cap: string | null): string | null {
  if (!cap) return existing;
  if (!existing) return cap;
  return `(${existing}) and (${cap})`;
}

/** One capability-filter predicate paired with its capability origin name —
 *  used by the retrieval emitter to apply each cap as a separately-gated Ecto
 *  `where` pipe stage so a call-site `ignoring` bypass can skip individual
 *  origins at runtime.  Mirrors `vanillaCapabilityFilter`'s rendering exactly
 *  (same principal pinning / actor gating), but keyed per filter rather than
 *  conjoined into one string.  A filter whose origin is `undefined`
 *  (bare/hand-written) renders with `origin: undefined` and is never bypassable. */
export function vanillaCapabilityFilterParts(
  agg: AggregateIR,
  contextModule: string,
  opts?: { actor?: boolean },
): { origin: string | undefined; pred: string }[] {
  const ctx: RenderCtx = { thisName: "record", contextModule, foundation: "vanilla" };
  const parts: { origin: string | undefined; pred: string }[] = [];
  (agg.contextFilters ?? []).forEach((p, i) => {
    if (!opts?.actor && exprUsesCurrentUser(p)) return;
    const pred = isDeepScopeFilter(p)
      ? renderDeepScopeEcto(ctx.thisName, deepScopeAnchorClaim(p))
      : exprUsesCurrentUser(p)
        ? pinPrincipal(renderExpr(p, ctx))
        : renderExpr(p, ctx);
    parts.push({ origin: agg.contextFilterOrigins?.[i], pred });
  });
  return parts;
}
