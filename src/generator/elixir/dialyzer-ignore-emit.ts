// ---------------------------------------------------------------------------
// `.dialyzer_ignore.exs` template — emitted at project root.
//
// Captures the unfixable Dialyzer noise that Ash macros (and the
// Phoenix router's macro-heavy `defmodule MyAppWeb.Router do; use
// Phoenix.Router; ...end` block) produce against the generated
// Phoenix output.  Mirrors the recipe from the user's Ash specing
// guide, captured into docs/proposals/cross-stack-static-analysis.md:
//
//   1. lib/ash/.*           — Ash core macros
//   2. lib/ash_postgres/.*  — AshPostgres data-layer macros
//   3. lib/ash_phoenix/.*   — AshPhoenix integration macros
//   4. lib/<app>_web/router.ex — Phoenix.Router DSL is macro-heavy too
//
// The file is consumed by Dialyxir's `mix dialyzer` task — inert
// until the Dialyzer gate lands as Tier 4 of the Phoenix ladder (see
// `docs/proposals/cross-stack-static-analysis.md`).  Shipping it now
// future-proofs the project: the moment Dialyxir is added as a dep
// and `mix dialyzer` is run, the noise floor is already tuned.
//
// Paired with the mix.exs `dialyzer: [ignore_warnings:
// ".dialyzer_ignore.exs"]` config block (`shell/project.ts`).
// ---------------------------------------------------------------------------

export function renderDialyzerIgnoreExs(appName: string): string {
  return `# Auto-generated.
#
# Dialyzer warnings to silence — the macro-heavy code below produces
# false positives that aren't actionable from this project's source.
# Consumed by Dialyxir (\`mix dialyzer\`); inert when Dialyxir isn't
# installed.
#
# Re-evaluate after each Ash major bump and after adding new
# top-level Phoenix modules: the ignore list should stay as narrow
# as the noise actually justifies, not a blanket suppression.
[
  # Ash framework internals — generated code Dialyzer misreads.
  {~r/lib\\/ash\\/.*/, :_},
  {~r/lib\\/ash_postgres\\/.*/, :_},
  {~r/lib\\/ash_phoenix\\/.*/, :_},

  # Phoenix.Router DSL is macro-heavy — \`use Phoenix.Router\` injects
  # code Dialyzer's success-typing can't follow without extra hints.
  {"lib/${appName}_web/router.ex", :_}
]
`;
}
