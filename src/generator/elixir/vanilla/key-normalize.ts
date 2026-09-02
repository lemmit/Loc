import type { TypeIR } from "../../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Inbound wire-key normalization (§15) — the private `__normalize_keys/1` defp
// every generated Ecto changeset applies to its incoming attrs before `cast/3`.
//
// Wire bodies arrive camelCase (the cross-backend contract; the OpenAPI spec
// declares camelCase properties), but Ecto casts the SNAKE-cased column atoms
// (`:commit_sha`), matching keys verbatim — so a multi-word field (`"runCount"`)
// silently drops → `validate_required` → not-null violation / spurious 422.
//
// The aggregate `base_changeset` snakes its top-level keys, but Ecto's
// `cast_assoc` / `cast_embed` recurse into a NESTED changeset (the entity part's
// / value-collection's own `changeset/2`) with the nested sub-map still
// camelCase.  Fix compositionally: every changeset snakes its OWN top-level
// keys, so each level of the recursion casts cleanly.  Values are left untouched
// — a plain `json`/`map` column (cast as `:map`, stored verbatim) is never routed
// through a nested changeset, so its arbitrary keys are preserved.
// ---------------------------------------------------------------------------

/** The `defp __normalize_keys/1` clauses (no leading blank line) — snake-case the
 *  top-level string keys of a wire body, leaving values untouched.  Idempotent on
 *  already-snake keys.  Emitted into each changeset module that `cast/3`s
 *  snake-cased column atoms. */
export const NORMALIZE_KEYS_DEFP = `  # Snake-case the top-level wire keys so camelCase bodies cast cleanly.
  defp __normalize_keys(attrs) when is_map(attrs) do
    Map.new(attrs, fn
      {k, v} when is_binary(k) -> {Macro.underscore(k), v}
      {k, v} -> {k, v}
    end)
  end

  defp __normalize_keys(attrs), do: attrs`;

/** The `defp __normalize_vo_keys/2` clauses — snake-case the keys INSIDE a
 *  value-object field's value (`{"dims": {"maxWidth": 3}}` → `{"dims":
 *  {"max_width": 3}}`), the one level `__normalize_keys/1` above deliberately
 *  does not reach.
 *
 *  A single value object is stored as a `field :<name>, :map` jsonb column —
 *  cast verbatim, never routed through a nested changeset — so its sub-keys
 *  arrived on the wire in camelCase and were STORED that way, while every read
 *  site (`wire-serialize.ts`, the expression renderer's VO sub-field read, the
 *  VO's own `new/1` constructor) looks up the SNAKE key.  A multi-word VO field
 *  therefore round-tripped as `null` on Phoenix and nowhere else (F2-W-01).
 *
 *  Snake is the canonical stored key, so the write side is what moves; the
 *  serializer keeps a camelCase fallback arm for rows an older build wrote.
 *  Keyed by `to_string(k)` so an atom-keyed attrs map (an internal caller)
 *  normalizes the same way, and idempotent on already-snake keys. */
export const NORMALIZE_VO_KEYS_DEFP = `  # Snake-case the keys INSIDE a value-object field's jsonb value — \`cast/3\`
  # stores that map verbatim, so nothing else would.
  defp __normalize_vo_keys(attrs, fields) when is_map(attrs) do
    Map.new(attrs, fn {k, v} ->
      if to_string(k) in fields, do: {k, __vo_value(v)}, else: {k, v}
    end)
  end

  defp __normalize_vo_keys(attrs, _fields), do: attrs

  defp __vo_value(value) when is_list(value), do: Enum.map(value, &__vo_value/1)

  defp __vo_value(value) when is_map(value) and not is_struct(value) do
    Map.new(value, fn
      {k, v} when is_binary(k) -> {Macro.underscore(k), v}
      {k, v} -> {k, v}
    end)
  end

  defp __vo_value(value), do: value`;

/** Is this field's value a VALUE OBJECT map (or a list of them)?  Those are the
 *  columns whose jsonb sub-keys `__normalize_vo_keys/2` must reach — `cast/3`
 *  stores the map verbatim, so nothing downstream would (F2-W-01). */
export function isVoValuedType(t: TypeIR): boolean {
  switch (t.kind) {
    case "valueobject":
      return true;
    case "optional":
      return isVoValuedType(t.inner);
    case "array":
      return isVoValuedType(t.element);
    default:
      return false;
  }
}
