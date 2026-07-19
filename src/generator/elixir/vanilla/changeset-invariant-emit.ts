// ---------------------------------------------------------------------------
// Cross-field aggregate-invariant enforcement for the vanilla (Ecto/Phoenix)
// changeset — the `validate_invariants/1` seam.
//
// `changeset-emit.ts` renders SINGLE-field invariants (`amount >= 0`,
// `sku.length > 0`, `email.matches(...)`) as idiomatic `validate_number` /
// `validate_length` / `validate_format` lines (via `singleFieldConstraints`).
// A CROSS-field invariant (`handle != email`, `startDate <= endDate`) fits no
// single-field native chain, so the classifier returns null and — before this
// module — it was **silently dropped on every path**: create, PATCH, and
// operation persist all skipped it, while the other four backends 400 it at the
// domain floor (`docs/audits/generated-code-ddd-review-2026-07.md`).
//
// The fix mirrors the other backends' `AssertInvariants()`: a custom Ecto
// validation that reads the PROPOSED struct (`apply_changes/1` — the record with
// the changeset's changes applied, valid or not) and `add_error`s when the
// predicate is false.  The predicate is rendered by the same vanilla
// expression renderer the domain bodies use, with `this.<prop>` bound to the
// applied `data` struct — so `handle != email` renders `data.handle != data.email`,
// byte-for-byte the comparison the domain core would run.
//
// Scope is deliberately tight: only invariants whose every leaf is a SCALAR
// `this`-property / enum-value / literal (no collection walks, no method calls,
// no derived getters, no `currentUser`) — exactly the cross-field comparisons.
// Collection / derived / actor-gated invariants stay out (they need machinery a
// changeset validator can't host); single-field ones already have their native
// line.  Empty when an aggregate has no such invariant → byte-identical output.
// ---------------------------------------------------------------------------

import type { AggregateIR, ExprIR, InvariantIR } from "../../../ir/types/loom-ir.js";
import { pickErrorPath, singleFieldConstraints } from "../../../ir/validate/invariant-classify.js";
import { messageCode } from "../../../util/message-code.js";
import { snake } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** A scalar this-property / enum-value / literal reads cleanly off the applied
 *  struct (`data.<col>`); a collection walk, method call, derived getter,
 *  `currentUser`, helper, or resource does not — those keep their (absent)
 *  domain-level story rather than a broken changeset read.  The allow-list is
 *  intentionally narrow: comparison/logical operators over scalar `this`-props
 *  are exactly the cross-field shape this seam targets. */
function structEvaluable(e: ExprIR, scope: ReadonlySet<string> = new Set()): boolean {
  switch (e.kind) {
    case "literal":
      // `now()` is non-deterministic in a validator; every other literal
      // (incl. money — the changeset runs server-side with Decimal) reads fine.
      return e.lit !== "now";
    case "id":
      return true; // `data.id` is a real column
    case "ref":
      switch (e.refKind) {
        case "this-prop":
        case "this-vo-prop":
        case "enum-value":
          return true;
        case "let":
        case "lambda":
          return scope.has(e.name);
        default:
          // this-derived (not a stored column), helper-fn, current-user,
          // resource, param, unknown — not readable off the applied struct.
          return false;
      }
    case "paren":
      return structEvaluable(e.inner, scope);
    case "unary":
      return structEvaluable(e.operand, scope);
    case "binary":
      return structEvaluable(e.left, scope) && structEvaluable(e.right, scope);
    case "ternary":
      return (
        structEvaluable(e.cond, scope) &&
        structEvaluable(e.then, scope) &&
        structEvaluable(e.otherwise, scope)
      );
    default:
      // member / method-call / call / match / new / object / list / convert /
      // this / action-ref — all reject: they read collections, walk into VOs,
      // or run domain logic a changeset validator can't reproduce.
      return false;
  }
}

/** A MESSAGED rule routes to the `validate_invariants/1` residual carrier — so
 *  its wire `code` rides the `add_error` metadata (Ecto's native validators
 *  can't carry a custom key) — when its predicate is renderable against the
 *  applied struct: either a struct-evaluable cross-field comparison OR a
 *  recognized single-field shape (`.length` / `.matches` / numeric bound, which
 *  `renderExpr` renders as `String.length` / `Regex.match?` / `Decimal.compare`).
 *  A message-LESS single-field rule is unaffected — it keeps its native
 *  `validate_*` line (byte-identical). Consumed by BOTH `residualInvariants`
 *  (to include it here) and `changeset-emit`'s native path (to exclude it
 *  there), so the two never double-emit. */
export function messagedRoutesToResidual(inv: InvariantIR): boolean {
  if (inv.message == null) return false;
  const renderable = structEvaluable(inv.expr) || singleFieldConstraints(inv) !== null;
  return renderable && (inv.guard === undefined || structEvaluable(inv.guard));
}

/** Aggregate invariants that need the `validate_invariants/1` seam: message-less
 *  cross-field comparisons (fully evaluable against the applied struct), plus
 *  every MESSAGED rule that routes here to carry its wire `code`. */
export function residualInvariants(agg: AggregateIR): InvariantIR[] {
  return (agg.invariants ?? []).filter(
    (inv) =>
      (inv.message == null &&
        singleFieldConstraints(inv) === null &&
        structEvaluable(inv.expr) &&
        (inv.guard === undefined || structEvaluable(inv.guard))) ||
      messagedRoutesToResidual(inv),
  );
}

/** True when the aggregate carries at least one cross-field invariant the
 *  `validate_invariants/1` seam enforces — gates both the changeset pipe and the
 *  operation-persist pipe (byte-identical when false). */
export function aggregateHasResidualInvariants(agg: AggregateIR): boolean {
  return residualInvariants(agg).length > 0;
}

/** The `validate_invariants/1` function body — a public `def` (the context
 *  facade's operation-persist path pipes through it too, not just the module's
 *  own `base_changeset`/`update_changeset`).  Empty string when the aggregate
 *  has no residual invariant.  `contextModule` is the `<App>.<Ctx>` prefix the
 *  expression renderer uses for `this`-rooted references. */
export function renderInvariantValidatorFn(agg: AggregateIR, contextModule: string): string {
  const residuals = residualInvariants(agg);
  if (residuals.length === 0) return "";
  const rc: RenderCtx = { thisName: "data", contextModule, foundation: "vanilla" };
  const fallbackField = agg.fields?.[0]?.name ?? "id";

  const checks = residuals.map((inv) => {
    const pred = renderExpr(inv.expr, rc);
    const field = snake(pickErrorPath(inv) ?? fallbackField);
    const msg = inv.message ? inv.message.text : `must satisfy: ${inv.source}`;
    // A messaged rule attaches the stable content-hash wire `code` (the i18n
    // key) as `add_error` metadata (`loom_code:`), surfaced by the 422 handler;
    // a message-less rule adds no metadata (byte-identical).
    const codeOpt = inv.message
      ? `, loom_code: ${JSON.stringify(messageCode(inv.message.text))}`
      : "";
    const violate = `add_error(changeset, :${field}, ${JSON.stringify(msg)}${codeOpt})`;
    const guarded = inv.guard
      ? `    changeset =
      if ${renderExpr(inv.guard, rc)} do
        if ${pred}, do: changeset, else: ${violate}
      else
        changeset
      end`
      : `    changeset =
      if ${pred}, do: changeset, else: ${violate}`;
    return guarded;
  });

  return `  @doc "Assert the aggregate's cross-field invariants on the proposed struct — an unmet one surfaces as a changeset error (422), the domain floor the other backends enforce at construction."
  def validate_invariants(changeset) do
    data = apply_changes(changeset)

${checks.join("\n\n")}

    changeset
  end`;
}
