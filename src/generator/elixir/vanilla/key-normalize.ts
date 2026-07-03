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
