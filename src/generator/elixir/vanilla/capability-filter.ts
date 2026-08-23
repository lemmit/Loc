// ---------------------------------------------------------------------------
// Vanilla capability-filter helper.
//
// A `filter <expr>` capability (`contextFilters` on the aggregate) must be
// AND-ed into EVERY root read of the aggregate.  Plain Ecto has no global
// query filter, so the generated repository / retrieval modules must
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

import type { AggregateIR, ExprIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import {
  deepScopeAnchorClaim,
  deepScopeTenantClaim,
  guidFromStringSelfScope,
  isDeepScopeFilter,
} from "../../../ir/util/tenant-stance.js";
import { desugarAuthzFilterInApp } from "../../_expr/authz-filter-inapp.js";
import {
  type RenderCtx,
  renderDeepScopeEcto,
  renderDeepScopeInApp,
  renderExpr,
  renderGuidClaimSelfScopeEcto,
} from "../render-expr.js";

export { aggregateUsesPrincipalContextFilter } from "../../../ir/types/loom-ir.js";

/** Rewrite a principal predicate's `current_user.<field>` accesses into the
 *  fail-closed pinned form for an Ecto `where:`.  No-op for non-principal
 *  predicates (they only touch `record.*`). */
function pinPrincipal(rendered: string): string {
  return rendered.replace(/\bcurrent_user\.([a-z0-9_]+)/g, "^(current_user && current_user.$1)");
}

/** One capability/write-scope predicate as an Ecto `where:` fragment, with the
 *  principal side made fail-closed.  The `"guid-from-string"` registry
 *  self-scope needs more than `pinPrincipal`'s pin — the claim is raw token
 *  text bound against a `:binary_id` field, so Ecto casts it and a MALFORMED
 *  claim raised `Ecto.Query.CastError` (a 500 for an ordinary bad token).  That
 *  one shape routes to `renderGuidClaimSelfScopeEcto`, which casts in Elixir
 *  and pins nil on failure; everything else keeps today's rendering.  (The
 *  deep-scope sentinel is intercepted by the callers, which own actor gating.) */
function renderPrincipalFilter(p: ExprIR, ctx: RenderCtx): string {
  const selfScope = guidFromStringSelfScope(p);
  if (selfScope) return renderGuidClaimSelfScopeEcto(ctx.thisName, selfScope.claim);
  return exprUsesCurrentUser(p) ? pinPrincipal(renderExpr(p, ctx)) : renderExpr(p, ctx);
}

/** A read's capability filter-bypass spec (`ignoring <Cap>` / `ignoring *`),
 *  carried by capability NAME on `FindIR` / the repo-run stmt.
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
  // `filterArgs: true` — these predicates are spliced into `from(... where: ...)`
  // Ecto queries, where money/decimal/datetime are data-layer-native (Postgres
  // columns), NOT `Decimal`/`DateTime` structs.  Without it a money/datetime
  // comparison renders the in-memory `Decimal.compare(...)` struct API, which is
  // not a valid Ecto query expression → `mix compile` fails.  (bool/id/string/enum
  // render identically in both modes, so previously-working filters are unchanged.)
  const ctx: RenderCtx = {
    thisName: "record",
    contextModule,
    filterArgs: true,
  };
  const preds = (agg.contextFilters ?? [])
    .filter((_, i) => !isFilterBypassed(agg.contextFilterOrigins?.[i], opts?.bypass))
    .filter((p) => opts?.actor || !exprUsesCurrentUser(p))
    .map((p) =>
      // The `deep` sentinel renders its own fail-closed pinned fragment — do
      // NOT run it through `pinPrincipal` (it already pins).
      isDeepScopeFilter(p)
        ? renderDeepScopeEcto(ctx.thisName, deepScopeAnchorClaim(p))
        : renderPrincipalFilter(p, ctx),
    );
  if (preds.length === 0) return null;
  // `and` is a reserved word in Elixir — the infix form is the only valid one
  // inside `where:`.  Parenthesise each so a low-precedence operator inside one
  // (`a or b`) can't bind across the join.
  return preds.length === 1 ? preds[0]! : preds.map((p) => `(${p})`).join(" and ");
}

/** The aggregate's `writeScopeFilter` (authorization Phase 3 P3.1 — the WRITE
 *  ladder) as a single Ecto `where:` predicate, or null when the aggregate has
 *  no write-scope narrowing.  Rendered exactly like a principal capability read
 *  filter (deep sentinel → the fail-closed pinned LIKE fragment; the floor →
 *  `pinPrincipal(...)`), so the write guard needs no new render path. */
export function vanillaWriteScopeFilter(agg: AggregateIR, contextModule: string): string | null {
  if (!agg.writeScopeFilter) return null;
  // See `vanillaCapabilityFilter`: rendered into an Ecto `where:`, so money/
  // decimal/datetime must use the native-query form (`filterArgs: true`).
  const ctx: RenderCtx = {
    thisName: "record",
    contextModule,
    filterArgs: true,
  };
  const p = agg.writeScopeFilter;
  return isDeepScopeFilter(p)
    ? renderDeepScopeEcto(ctx.thisName, deepScopeAnchorClaim(p))
    : renderPrincipalFilter(p, ctx);
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
  // See `vanillaCapabilityFilter`: rendered into an Ecto `where:` pipe, so
  // money/decimal/datetime must use the native-query form (`filterArgs: true`).
  const ctx: RenderCtx = {
    thisName: "record",
    contextModule,
    filterArgs: true,
  };
  const parts: { origin: string | undefined; pred: string }[] = [];
  (agg.contextFilters ?? []).forEach((p, i) => {
    if (!opts?.actor && exprUsesCurrentUser(p)) return;
    const pred = isDeepScopeFilter(p)
      ? renderDeepScopeEcto(ctx.thisName, deepScopeAnchorClaim(p))
      : renderPrincipalFilter(p, ctx);
    parts.push({ origin: agg.contextFilterOrigins?.[i], pred });
  });
  return parts;
}

// ---------------------------------------------------------------------------
// IN-APP (document-shape) capability filtering.
//
// A `shape: document` aggregate persists as ONE opaque jsonb column, so there
// is no per-field Ecto `where:` to AND the capability predicate into — the same
// situation node/java/python/dotnet are in.  Those four filter document reads
// IN-APP over the rehydrated instance; the plain-Ecto path does the same over
// the `%<Agg>.Data{}` embed the row rehydrates to (`record = row.data`).
//
// Two things differ from the Ecto rendering above, and both are load-bearing:
//
//   1. The `authz-filter` SENTINELS (`deny` / `scope`) have no in-app column
//      predicate to be.  They are desugared to ordinary `ExprIR` FIRST, by the
//      shared `desugarAuthzFilterInApp` the other three in-app backends already
//      use — so `deny` becomes `false`, and `allow deep` becomes the
//      DEEP_SCOPE_SEMANTICS expression over the row's own `dataKey`/`tenantId`
//      (both of which live INSIDE the blob on a document aggregate).  Rendering
//      the sentinel unchanged would emit an Ecto `fragment(...)`, which is not
//      valid Elixir outside a query.
//   2. A principal claim can't be `^`-pinned (there is no query to pin into),
//      so fail-closed has to be spelled out in Elixir: `current_user.<claim>`
//      becomes `(current_user && current_user.<claim>)` (nil-safe access — an
//      in-process read threads no actor), and the whole conjunction is guarded
//      by `current_user != nil`, so a principal-scoped read with NO actor
//      matches nothing exactly as a pinned NULL does in SQL.  Without that
//      guard a nil claim would compare EQUAL to a nil column in Elixir (SQL's
//      `= NULL` is never true) — a fail-OPEN divergence from the Ecto path.
// ---------------------------------------------------------------------------

/** The in-app rendering of a `deny` carve-out — a call to the repository's
 *  `__denied?/1` helper ({@link DOC_DENY_HELPER}).  See `renderDocPredicate`
 *  for why this is not the literal `false`. */
export const DOC_DENY_PREDICATE = "__denied?(row)";

/** The private helper {@link DOC_DENY_PREDICATE} calls.  Emitted once per
 *  document repository whose filters contain a `deny`. */
export const DOC_DENY_HELPER = `  # \`deny\` carve-out (authorization Phase 4): the visible set is EMPTY.  Spelled
  # as a runtime membership test rather than the literal \`false\` because the
  # compiler FOLDS a literal — \`… and false\` is a typing violation, and a read
  # that provably never returns \`{:ok, _}\` makes each caller's success branch
  # dead code.  Both fail \`mix compile --warnings-as-errors\`; the SQL path is
  # unaffected only because \`fragment("false")\` is opaque to the compiler.
  @spec __denied?(term()) :: boolean()
  defp __denied?(row), do: Enum.member?([], row)`;

/** The document root's `id` is NOT in the blob — `@primary_key false` on the
 *  `<Agg>.Data` embed keeps it on the ROW.  So a predicate reading `this.id`
 *  renders as `record.id` against a struct that has no such key (a runtime
 *  `KeyError`); lift those reads to the row binding every in-app read site has
 *  in scope.  Anchored on a non-member, non-word char so a value-object
 *  sub-field (`record.money.id`) and a longer field name (`record.identifier`)
 *  are left alone. */
function liftDocRootId(rendered: string, rowVar: string): string {
  return rendered.replace(/(^|[^.\w])record\.id\b/g, `$1${rowVar}.id`);
}

/** `current_user.<claim>` made nil-safe for an IN-MEMORY predicate — the in-app
 *  twin of `pinPrincipal`'s `^(current_user && …)` Ecto pin. */
function guardPrincipalInApp(rendered: string): string {
  return rendered.replace(
    /(^|[^.\w])current_user\.([a-z0-9_]+)/g,
    "$1(current_user && current_user.$2)",
  );
}

/** One predicate rendered for the IN-APP document read path: sentinels
 *  desugared, `this.id` lifted to the row, principal claims made nil-safe. */
function renderDocPredicate(
  p: ExprIR,
  agg: AggregateIR,
  contextModule: string,
  rowVar: string,
): string {
  // The `deep`/`global` sentinel renders its own already-fail-closed in-memory
  // fragment (Elixir's `nil <> "."` raises, so the descendant prefix has to be
  // interpolated rather than concatenated — see `renderDeepScopeInApp`).  Do
  // NOT run it through `guardPrincipalInApp`: it pins its claims itself, the
  // same split `vanillaCapabilityFilter` makes for the Ecto path.
  if (isDeepScopeFilter(p)) {
    return renderDeepScopeInApp("record", deepScopeAnchorClaim(p), deepScopeTenantClaim(p));
  }
  // The `deny` carve-out is always-false, but it must NOT render as the literal
  // `false`.  Elixir 1.18's type checker folds it: `… and false` is reported as
  // a typing violation, and a `find_by_id` that can only return
  // `{:error, :not_found}` makes every CALLER's `{:ok, _}` branch statically
  // dead — both are `--warnings-as-errors` failures.  The SQL path never hits
  // this because `fragment("false")` is opaque to the compiler; in-app the
  // equivalent opacity is a runtime membership test against the empty visible
  // set, which is also a fair reading of what `deny` means.
  if (p.kind === "authz-filter" && p.filter.kind === "deny") return DOC_DENY_PREDICATE;
  // `docStruct` (not `filterArgs`): the predicate runs in memory over the
  // rehydrated embed, so scalar intrinsics take their `String.*` / `DateTime.*`
  // forms rather than the Ecto `fragment(...)` ones.
  const ctx: RenderCtx = {
    thisName: "record",
    contextModule,
    foundation: "vanilla",
    docStruct: true,
  };
  return guardPrincipalInApp(
    liftDocRootId(renderExpr(desugarAuthzFilterInApp(p, agg.name), ctx), rowVar),
  );
}

/** The aggregate's capability filters as a single IN-MEMORY Elixir boolean
 *  expression over `record` (the rehydrated `%<Agg>.Data{}` embed) and `rowVar`
 *  (the loaded root row), or null when it has none / all are bypassed.
 *
 *  Mirrors {@link vanillaCapabilityFilter}'s actor gating and `ignoring` bypass
 *  exactly — only the RENDERING differs (see the block comment above). */
export function vanillaDocCapabilityFilter(
  agg: AggregateIR,
  contextModule: string,
  rowVar: string,
  opts?: { actor?: boolean; bypass?: FilterBypass },
): string | null {
  const preds = (agg.contextFilters ?? [])
    .filter((_, i) => !isFilterBypassed(agg.contextFilterOrigins?.[i], opts?.bypass))
    .filter((p) => opts?.actor || !exprUsesCurrentUser(p));
  if (preds.length === 0) return null;
  const rendered = preds.map((p) => renderDocPredicate(p, agg, contextModule, rowVar));
  const body = rendered.length === 1 ? rendered[0]! : rendered.map((p) => `(${p})`).join(" and ");
  return preds.some(exprUsesCurrentUser) ? `current_user != nil and (${body})` : body;
}

/** The aggregate's `writeScopeFilter` as an IN-MEMORY Elixir predicate (the
 *  document twin of {@link vanillaWriteScopeFilter}), or null when the
 *  aggregate has no write-scope narrowing. */
export function vanillaDocWriteScopeFilter(
  agg: AggregateIR,
  contextModule: string,
  rowVar: string,
): string | null {
  if (!agg.writeScopeFilter) return null;
  const body = renderDocPredicate(agg.writeScopeFilter, agg, contextModule, rowVar);
  return exprUsesCurrentUser(agg.writeScopeFilter) ? `current_user != nil and (${body})` : body;
}
