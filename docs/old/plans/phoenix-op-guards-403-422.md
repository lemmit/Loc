# Phoenix boundary — `requires`/`precondition` deny with 403/422, not 500

**Status:** in progress (branch `claude/generated-code-ddd-review-ld6gmz`).
**Origin:** `docs/audits/generated-code-ddd-review-2026-07.md` §"Phoenix — signable"
(P1, the Phoenix-boundary row), sub-item: "`requires`/`precondition` raise
`ArgumentError` → 500 where the spec says 403/422 (the workflow renderer already
does tuples + `respond/2` correctly — the two renderers disagree)."

## The bug (reproduced on fresh `main`)

A Phoenix aggregate **operation** guard raises where an expected denial should
be a tuple:

```elixir
def set_handle_account(%Account{} = record, params) when is_map(params) do
  h = Map.get(params, "h")
  if not (record.email != ""), do: raise(ArgumentError, "Forbidden: email != \"\"")     # → 500
  if not (h != ""), do: raise(ArgumentError, "Precondition failed: h != \"\"")           # → 500
  ...
end
```

`requires` should deny with **403 Forbidden** and `precondition` with **400/422**;
both instead raise `ArgumentError`, which the fallback error handler turns into a
**500** — the wrong status AND a stacktrace leak on an *expected* denial. The
other backends return the correct status at the domain floor.

## The fix (mirror the workflow renderer)

The event-sourced **workflow** renderer already lowers these to `with`-chain
guards over an `ensure/2` helper (`workflow-eventsourced-emit.ts`):

```elixir
:ok <- ensure(<expr>, :forbidden)             # requires
:ok <- ensure(<expr>, :precondition_failed)   # precondition
```

and the controller maps `{:error, :forbidden}` → 403 / `{:error,
:precondition_failed}` → 422 via the ProblemDetails responder. Make the
aggregate **operation** renderer emit the same tuple contract instead of
`raise ArgumentError`, and thread the controller mapping — so the two renderers
agree and an expected denial returns the documented status, not a 500.

## Scope

`src/generator/elixir/vanilla/{context-emit,operation-returns-emit}.ts` (named +
returning op bodies: guard → `{:error, reason}` tuple, not raise),
`api-emit.ts` / `problem-details-emit.ts` (controller maps the tuples to
403/422). Tests: a generator test asserting the op body returns the tuples +
the controller responds 403/422; runtime status via conformance.

**Out (rest of the Phoenix-boundary row, tracked follow-ons):** #2 operation
persistence skips changeset validation; #3 cross-field invariant dropped; #4
derived-property OpenAPI contradiction; misc (duplicated op bodies, view
`Map.from_struct` dumps, dead Squad `Repo.delete`).
