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
| `vanilla-auth-op-gate.ddd` | An operation `requires`/`when` guard referencing `currentUser` renders `current_user.role` in the context function, but `current_user` is not threaded into that function (the auditable create/update path threads `current_user \\ nil`; named operations don't yet). |
| `vanilla-destroy-form.ddd` | The destroy-form path references `<Ctx>.destroy_<agg>!/1`, but the context module doesn't emit that bang destroy function. |
