// ---------------------------------------------------------------------------
// The ONE `page`/`pageSize` query-control reader every vanilla-Phoenix
// controller emits.
//
// Two things used to be wrong here, and they are the same bug seen twice:
//
//  1. The helper was COPIED — `find-controller.ts` emitted one `page_param/4`
//     (also consumed by `api-emit.ts`'s auto-`findAll` `index`) and
//     `explicit-handlers-emit.ts` emitted a byte-identical second one for the
//     paged-run queryHandler routes.  Two copies, one contract.
//  2. Both copies CLAMPED an out-of-range value (`min(v, limit)`, and anything
//     below 1 silently fell back to the default) while `openapi-emit.ts`
//     publishes `minimum: 1` / `maximum: <limit>` for the very same params.  So
//     elixir answered `200` for `?page=0` / `?pageSize=100000` where the
//     OpenAPI document it serves says the request is invalid — and where node
//     (zod `.min(1).max(…)` → the 422 hook) and python (`Query(ge=…, le=…)` →
//     the 422 handler) both refuse.  A spec-driven client (or schemathesis,
//     which only fuzzes the node leg today) reads that as the backend
//     contradicting its own contract.
//
// The reader now REFUSES an out-of-range value with the §3.2 `errors[]` 422 —
// byte-identical envelope to the changeset rung, since it goes through
// `ProblemDetails.validation_errors_response/2`, the one sender.  An
// absent/blank/unparseable value still falls back to the shared default (the
// pre-existing lenient coercion; narrowing THAT is a separate contract call,
// and node/python differ from each other on it too).
// ---------------------------------------------------------------------------

import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  PAGED_MAX_PAGE,
  PAGED_MAX_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type { EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";

/** The bound names the `with` clauses below introduce.  Deliberately
 *  `_arg`-SUFFIXED rather than `__`-prefixed: a LEADING underscore tells Elixir
 *  the value is meant to be ignored, so `mix compile --warnings-as-errors`
 *  rejects `__page` the moment the read consumes it.  The suffix keeps them
 *  clear of `page`/`page_size`, which are legal Loom find-param names. */
export const PAGE_VAR = "page_arg";
export const PAGE_SIZE_VAR = "page_size_arg";

/** The two `with` clauses that validate the paging controls, in the order the
 *  published OpenAPI parameters appear.  Prepended to a paged read's existing
 *  `with`, so the repository call is never reached with an out-of-range window.
 *  Callers join them into the clause list themselves (indentation is per-site). */
export const PAGE_WITH_CLAUSES: readonly string[] = [
  `{:ok, ${PAGE_VAR}} <- page_param(params, "page", ${PAGED_DEFAULT_PAGE}, ${PAGED_MAX_PAGE})`,
  `{:ok, ${PAGE_SIZE_VAR}} <- page_param(params, "pageSize", ${PAGED_DEFAULT_PAGE_SIZE}, ${PAGED_MAX_PAGE_SIZE})`,
];

/** The repository-call arguments those clauses bind — drop-in for the two
 *  inline `page_param(...)` calls the call sites used to pass. */
export const PAGE_CALL_ARGS: readonly string[] = [PAGE_VAR, PAGE_SIZE_VAR];

/** The `else` arm answering the refusal.  `problemDetails` is how the emitting
 *  controller names the module (aliased or fully qualified); `indent` is the
 *  column the `else` body sits at.
 *
 *  The trailing `other -> other` catch-all is load-bearing: adding an `else` to
 *  a `with` turns every previously-returned non-matching term into a
 *  `WithClauseError`, so without it a `{:error, :not_found}` from the read
 *  would change from "returned to Phoenix" into "raises". It keeps every
 *  non-paging path byte-identical in BEHAVIOUR. */
export function pagingElseArm(problemDetails: string, indent: string): string {
  return [
    `${indent}else`,
    `${indent}  {:error, {:invalid_paging, paging_errors}} ->`,
    `${indent}    ${problemDetails}.validation_errors_response(conn, paging_errors)`,
    "",
    `${indent}  other ->`,
    `${indent}    other`,
  ].join("\n");
}

/** The emitted `page_param/4` + its bounds clause — ONE definition, spliced by
 *  whichever controller carries a paged read. */
export const PAGE_PARAM_HELPER = `
  # The 1-based \`page\` / \`pageSize\` query-control reader (Phoenix delivers query
  # params as strings).  Absent / blank / unparseable → the shared default; a
  # value outside the \`minimum: 1\` / \`maximum: <limit>\` bounds this app PUBLISHES
  # in its own OpenAPI document is REFUSED with the §3.2 \`errors[]\` 422, not
  # clamped — clamping answered 200 to a request the contract calls invalid, and
  # diverged from node/python, which both 422.
  defp page_param(params, key, default, limit) do
    case params[key] do
      v when is_integer(v) ->
        __page_bounds(v, key, limit)

      v when is_binary(v) ->
        case Integer.parse(v) do
          {n, _} -> __page_bounds(n, key, limit)
          _ -> {:ok, default}
        end

      _ ->
        {:ok, default}
    end
  end

  defp __page_bounds(n, _key, limit) when n >= 1 and n <= limit, do: {:ok, n}

  defp __page_bounds(_n, key, limit) do
    {:error,
     {:invalid_paging,
      [
        %{
          pointer: "/" <> key,
          message: "must be between 1 and #{limit}",
          code: nil
        }
      ]}}
  end`;

/** Does any read in these contexts publish a paged envelope?  Gates the
 *  `ProblemDetails.validation_errors_response/2` responder the refusal sends
 *  through — an unused `def`/`defp` fails `mix compile --warnings-as-errors`,
 *  so an app with no paged read must stay byte-identical. */
export function contextsHavePagedReads(contexts: readonly EnrichedBoundedContextIR[]): boolean {
  return contexts.some(
    (c) =>
      (c.repositories ?? []).some((r) =>
        (r.finds ?? []).some((f) => !!pagedReturn(f.returnType)),
      ) || (c.queryHandlers ?? []).some((h) => !!h.returnType && !!pagedReturn(h.returnType)),
  );
}
