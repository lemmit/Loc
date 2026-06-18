// ---------------------------------------------------------------------------
// Vanilla capability-filter helper.
//
// A `filter <expr>` capability (`contextFilters` on the aggregate) must be
// AND-ed into EVERY root read of the aggregate.  The Ash foundation installs
// these once via the resource `base_filter`; plain Ecto has no global query
// filter, so the generated repository / retrieval / view modules must conjoin
// each predicate into every `from(record in <Agg>, where: …)` read site —
// exactly the Hono/Drizzle situation (half-applying a soft-delete filter would
// be a correctness hole).
//
// Predicates render under the `record` Ecto binding (`!this.isDeleted` →
// `not record.is_deleted`).  A `filter <Criterion>` reference inlines its
// predicate (vanilla has no Ash calculation to reify into).
//
// **Principal (tenancy) filters** (`this.tenantId == currentUser.tenantId`) are
// emitted only when the caller threads the request actor (`{ actor: true }`).
// `currentUser.tenantId` lowers to `current_user.tenant_id`; inside an Ecto
// `where:` the principal side must be PINNED, and it must stay fail-closed when
// no actor is present (an unauthenticated / workflow-internal read), so it
// renders as `^(current_user && current_user.tenant_id)` — a pinned `nil` makes
// the comparison match no rows (Ecto binds `= NULL`, never `IS NULL`).  This
// mirrors Ash's `actor: nil` → empty-result behaviour.  Callers that pass
// `{ actor: true }` MUST bind a `current_user` variable in scope.
// ---------------------------------------------------------------------------

import type { AggregateIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

export { aggregateUsesPrincipalContextFilter } from "../../../ir/types/loom-ir.js";

/** Rewrite a principal predicate's `current_user.<field>` accesses into the
 *  fail-closed pinned form for an Ecto `where:`.  No-op for non-principal
 *  predicates (they only touch `record.*`). */
function pinPrincipal(rendered: string): string {
  return rendered.replace(/\bcurrent_user\.([a-z0-9_]+)/g, "^(current_user && current_user.$1)");
}

/** The aggregate's capability filters as a single Ecto predicate (conjoined
 *  with the infix `and`, each parenthesised), or null when it has none.
 *  `contextModule` feeds the shared `renderExpr` (enum / type vocab).
 *
 *  Without `{ actor: true }` only NON-principal predicates are emitted (the
 *  no-actor read sites — and the byte-identical default).  With `{ actor: true }`
 *  the principal predicates are included too, pinned against a `current_user`
 *  the caller must have threaded into scope. */
export function vanillaCapabilityFilter(
  agg: AggregateIR,
  contextModule: string,
  opts?: { actor?: boolean },
): string | null {
  const ctx: RenderCtx = { thisName: "record", contextModule, foundation: "vanilla" };
  const preds = (agg.contextFilters ?? [])
    .filter((p) => opts?.actor || !exprUsesCurrentUser(p))
    .map((p) => (exprUsesCurrentUser(p) ? pinPrincipal(renderExpr(p, ctx)) : renderExpr(p, ctx)));
  if (preds.length === 0) return null;
  // `and` is a reserved word in Elixir — the infix form is the only valid one
  // inside `where:`.  Parenthesise each so a low-precedence operator inside one
  // (`a or b`) can't bind across the join.  (Mirrors the Ash `renderBaseFilter`.)
  return preds.length === 1 ? preds[0]! : preds.map((p) => `(${p})`).join(" and ");
}

/** Conjoin a capability-filter predicate with an existing `where:` predicate.
 *  Either side may be null (no existing filter / no capability filter). */
export function combineWhere(existing: string | null, cap: string | null): string | null {
  if (!cap) return existing;
  if (!existing) return cap;
  return `(${existing}) and (${cap})`;
}
