// ---------------------------------------------------------------------------
// Per-app shared type vocabulary — `<App>.Types`.
//
// One module per generated Phoenix project carrying the canonical
// Elixir typespecs the generator references from event modules,
// value-object modules, polymorphic readers, and aggregate helpers.
//
// Defines:
//   - `id()`             — UUID-as-string, the canonical Ash id shape
//   - `timestamp()`      — DateTime.t(), for inserted_at/updated_at fields
//   - `result(t)`        — `{:ok, t} | {:error, Ash.Error.t()}`
//   - `result_list(t)`   — `{:ok, [t]} | {:error, Ash.Error.t()}`
//
// Consumed by `renderTypespec` when the optional `typesModule`
// parameter is set: `id` → `<App>.Types.id()`, primitive `datetime` →
// `<App>.Types.timestamp()`.  Falls back to inline `String.t()` /
// `DateTime.t()` when the parameter is absent (used by direct
// renderTypespec unit tests and any emitter site that pre-dates the
// types-module wiring).
//
// Implements the "shared <App>.Types module" discipline captured in
// docs/proposals/cross-stack-static-analysis.md (Phoenix section).
// ---------------------------------------------------------------------------

export function renderTypesModule(typesModule: string): string {
  return `# Auto-generated.
defmodule ${typesModule} do
  @moduledoc """
  Shared type vocabulary for the application.

  Reference these aliases instead of inlining \`String.t()\` for ids or
  hand-rolling \`{:ok, _} | {:error, _}\` tuples — keeping the
  vocabulary in one place gives Dialyzer, IDE hover, and \`mix docs\`
  a single source of truth for the application's domain contracts.
  """

  @typedoc "Canonical resource identifier — UUID rendered as a string by Ash."
  @type id :: String.t()

  @typedoc "Wall-clock instant — Ash's :utc_datetime shape."
  @type timestamp :: DateTime.t()

  @typedoc "Successful or failed Ash result, parameterised on the success type."
  @type result(t) :: {:ok, t} | {:error, Ash.Error.t()}

  @typedoc "Successful or failed Ash list-returning result."
  @type result_list(t) :: {:ok, [t]} | {:error, Ash.Error.t()}
end
`;
}
