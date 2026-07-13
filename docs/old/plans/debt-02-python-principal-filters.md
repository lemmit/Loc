# Plan — DEBT-02 python relational principal capability filters

**Created:** 2026-06-22 · **Status:** ✅ SHIPPED (code-verified 2026-06-28 — `supportsPrincipalFilter('python')` returns `true` in `src/ir/validate/checks/system-checks.ts:1011`; `contextFilterPredicate` keeps `currentUser` predicates and renders them against the ambient `require_current_user()`; the `tenancy-filter.ddd` python-build fixture gates it. The `shape(embedded)` principal case also later landed (#1571 — `supportsPrincipalNonRelationalFilter` now includes python for `embedded`); only python's `shape(document)` stays gated.)

The last-backend parity gap on **principal-referencing** (`currentUser`, tenancy)
capability filters: node / dotnet / elixir / java all wire a
`filter this.tenantId == currentUser.tenantId` on a relational aggregate; **python
emits only the non-principal relational case** and the IR validator gates the
principal case off python.

## Current state (verified on fresh `main`)

- Gate `validateContextFilterSupport` (`src/ir/validate/checks/system-checks.ts`):
  `supportsPrincipalFilter(family)` returns `false` for `python`.
- `src/generator/python/find-predicate.ts` `contextFilterPredicate(...)` drops
  `exprUsesCurrentUser` predicates, AND-ing only non-principal filters into every
  root read (`all` / `find_by_id` / `find_many_by_ids` / finds / views /
  retrievals — woven by `repository-builder.ts`).
- Python already renders `current_user.<claim>` for **per-find** filters
  (`findUsesCurrentUser` → `current_user: User` param + `render-expr.ts` bind
  value). The rendering primitive exists.
- The auth middleware (`auth-emit.ts`) sets `request.state.current_user` (full
  principal); the obs `request_context_var` carries only `actor_id`.

## Design — ambient ContextVar accessor (mirror node)

Rather than thread a `current_user` parameter through every read method + caller,
mirror node's `requireCurrentUser()`: the auth middleware also stashes the full
principal in a `ContextVar`, and the repository reads the ambient accessor
(`require_current_user()`) when rendering the always-on principal predicate. Lower
call-site churn, fail-closed (no principal ⇒ scoped to no rows / raises), and the
predicate AND-s into the SQLAlchemy read exactly like the non-principal case.

The `auth: required` + system `user {}` precondition the other backends enforce
applies to python too (no request principal otherwise) — same diagnostic.

## Scope

Python backend only, **relational** aggregates. Out of scope: non-relational
(document/embedded) principal on python (a later slice, like Slice B elsewhere).

## Tests / gates

- Validator gate test: python relational principal filter accepted (was rejected);
  still requires `auth: required` + `user {}`.
- Python generator unit test: the principal predicate is AND-ed into the reads via
  the ambient accessor.
- `python-build` fixture `tenancy-filter.ddd` (relational + `filter this.tenantId
  == currentUser.tenantId` + `auth: required` + `user {}`), wired into the python
  build gate (`uv sync` + `ruff` + `mypy --strict` + `pytest`).
