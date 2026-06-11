// ---------------------------------------------------------------------------
// Jason.Encoder camelCase shim for Ash resource structs.
//
// Phoenix's default Jason serialisation walks an Ash struct's atom-keyed
// attribute map and writes those atom names verbatim — which surfaces as
// `snake_case` JSON keys (`created_at`, `pipeline_count`) since Ash
// attributes follow Elixir naming conventions.
//
// Hono (TypeScript) and .NET both serialise with `camelCase` keys.  The
// cross-generator conformance harness (`LOOM_E2E_STRICT_PARITY=1`) treats
// the divergence as a parity failure once strict mode is on.
//
// Per-resource fix follows the idiomatic Elixir / Phoenix pattern: each
// generated resource module is paired with a `defimpl Jason.Encoder, for:
// <Struct>` that delegates the encode work to this shared helper.  The
// helper takes the (struct, declared-atom-keys, opts) triple, projects
// the struct down to those keys, camel-cases them, and hands the result
// to `Jason.Encode.map/2`.
//
// One emission per project, lives at `lib/<app>/jason_camel_case.ex`.
// Avoids per-resource duplication of the conversion fn.
// ---------------------------------------------------------------------------

export function renderJasonCamelCaseModule(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.JasonCamelCase do
  @moduledoc """
  Encode an Ash resource struct's declared attribute set with camelCase
  JSON keys, so the Phoenix wire shape matches Hono / .NET.

  Each generated resource module pairs with a \`defimpl Jason.Encoder,
  for: <Struct>\` that calls \`encode_struct/3\` with the atom-keyed
  attribute list it wants to surface.
  """

  @doc """
  Encode \`value\` as a JSON object whose keys are the camelCase form
  of the snake_case atoms in \`fields\`.  Unknown / missing fields are
  silently dropped (so callers can list optional attributes without
  guarding existence).
  """
  def encode_struct(value, fields, opts) do
    value
    |> Map.from_struct()
    |> Map.take(fields)
    |> Map.new(fn {k, v} -> {camelize(k), v} end)
    |> Jason.Encode.map(opts)
  end

  @doc """
  Recursively convert a decoded JSON params map's camelCase string keys to
  the snake_case names Ash actions accept (\`createdAt\` → \`created_at\`,
  \`externalId\` → \`external_id\`).  The request-side inverse of the
  camelCase encoder above: Hono / .NET / the React client all send camelCase
  bodies, but Ash attribute / argument names are snake_case, so a create or
  update would otherwise reject every multi-word field as an unknown input.

  Only KEYS are rewritten — values pass through untouched (enum strings,
  ids, …) — and the walk descends into nested maps and lists so embedded
  value objects and contained collections are converted too.  Structs are
  left intact (a JSON params map carries none, but the guard keeps the walk
  total).
  """
  def decamelize_keys(%{__struct__: _} = struct), do: struct

  def decamelize_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {decamelize(k), decamelize_keys(v)} end)
  end

  def decamelize_keys(list) when is_list(list), do: Enum.map(list, &decamelize_keys/1)

  def decamelize_keys(other), do: other

  defp decamelize(key) when is_binary(key), do: Macro.underscore(key)
  defp decamelize(key), do: key

  defp camelize(key) when is_atom(key) do
    key |> Atom.to_string() |> camelize_string()
  end

  defp camelize_string(str) do
    case String.split(str, "_") do
      [head] -> head
      [head | rest] -> head <> Enum.map_join(rest, "", &String.capitalize/1)
    end
  end
end
`;
}

/**
 * Render the `defimpl Jason.Encoder, for: <Struct>` block that pairs
 * with an Ash resource module.  Emitted after the resource's
 * `defmodule ... end` close.
 *
 * @param structModule  fully-qualified module name (e.g. `PhoenixApp.Sales.Customer`)
 * @param fieldAtoms    atom-keyed attribute list, e.g. `[":id", ":name", ":inserted_at"]`
 * @param appModule     project's app module prefix (e.g. `PhoenixApp`),
 *                      used to resolve the shared helper module path
 */
export function renderJasonEncoderImpl(
  structModule: string,
  fieldAtoms: string[],
  appModule: string,
): string {
  return `defimpl Jason.Encoder, for: ${structModule} do
  def encode(value, opts) do
    ${appModule}.JasonCamelCase.encode_struct(value, [${fieldAtoms.join(", ")}], opts)
  end
end
`;
}
