# Pending vanilla-Phoenix fixtures (not yet compile-gated)

These `.ddd` fixtures exercise vanilla-Phoenix features that the generator does
**not** yet emit cleanly (`mix compile --warnings-as-errors` fails). They live in
this subdirectory so the `elixir-vanilla-build` gate skips them — both the
workflow's `ls .../*.ddd` and the test's `readdirSync` are non-recursive, so
anything under `pending/` is automatically excluded from the matrix.

Move a fixture back up to the parent directory once its gap is closed (and it
mix-compiles) — no workflow or test edit is needed; the dynamic enumeration
picks it up.

_None currently pending_ — `vanilla-auth-op-gate.ddd` was promoted back to the
gate once op-level `currentUser` threading shipped (§9 / #1568). Add a row here
when a new fixture exercises a gap that doesn't yet `mix compile`.
