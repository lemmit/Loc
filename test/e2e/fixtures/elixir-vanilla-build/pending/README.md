# Pending vanilla-Phoenix fixtures (not yet compile-gated)

These `.ddd` fixtures exercise vanilla-Phoenix features that the generator does
**not** yet emit cleanly (`mix compile --warnings-as-errors` fails). They live in
this subdirectory so the `elixir-vanilla-build` gate skips them — both the
workflow's `ls .../*.ddd` and the test's `readdirSync` are non-recursive, so
anything under `pending/` is automatically excluded from the matrix.

Move a fixture back up to the parent directory once its gap is closed (and it
mix-compiles) — no workflow or test edit is needed; the dynamic enumeration
picks it up.

| Fixture | Gap (tracked in `docs/plans/vanilla-phoenix-gaps.md`) |
|---|---|
| `vanilla-auth-op-gate.ddd` | **§13** — a LiveView `Action { c.<op> }` button on a (non-destroy) operation emits `<Ctx>.get_<agg>!(id)` + `<Ctx>.<op>_<agg>!(record)` **bang** calls in `handle_event/3`, but the context module emits no bang variants → `mix compile --warnings-as-errors` fails (`get_customer!/1`/`confirm_customer!/1` undefined). Sibling of §10 (which added only `destroy_<agg>!/1`). Op-level `currentUser` threading (the fixture's original blocker) *did* ship in #1568; this is a separate, newly-surfaced gap. |
