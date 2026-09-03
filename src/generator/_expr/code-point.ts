// ---------------------------------------------------------------------------
// String `.length` — the ONE definition of what a "character" is.
//
// A `.ddd` `s.length` (and every `len-*` single-field constraint derived from
// it — `minLength`/`maxLength` on the wire) counts **Unicode code points**.
//
// Why code points and not the host language's native string length: the
// constraint is PUBLISHED.  A `len-min`/`len-max`/`len-eq` invariant becomes
// `minLength`/`maxLength` in the emitted JSON Schema (`/openapi.json`), and
// JSON Schema defines those in code points — as does every conforming
// validator a generated client would use (ajv, Pydantic).  The host
// primitives disagree, and three of them disagreed with the schema the same
// server publishes:
//
//   JS      `s.length`               UTF-16 code units   ✗
//   C#      `s.Length`               UTF-16 code units   ✗
//   Java    `s.length()`             UTF-16 code units   ✗
//   Python  `len(s)`                 code points         ✓
//   Elixir  `String.length/1`        graphemes           ✗ (see below)
//
// So `"😀X"` — 2 code points, 3 UTF-16 code units — was simultaneously
// ACCEPTED by a `length == 3` rule on node/.NET/java and INVALID against the
// `minLength: 3, maxLength: 3` those same backends published for the field
// (schemathesis finding F5).  This module is that fix: one code-point snippet
// per target language, used by both the domain rule renderer and the
// wire-boundary validator emitter, so the two can never drift.
//
// The inventory above is the HOST BACKEND languages, but the same definition
// binds the CLIENT-side validators the frontends derive from the identical
// `SingleFieldPattern` table.  React/Vue/Svelte fold `len-*` into a zod
// `.refine` built on `tsCodePointLength`; **Angular** emits no zod schema at
// all, so its Reactive-Forms `ValidatorFn`s
// (`src/generator/angular/form-validators.ts`) are the only client check on
// that frontend and call `tsCodePointLength` too — `Validators.minLength` /
// `maxLength` read `control.value.length`, UTF-16 code units, and would put
// the form and the server it posts to in disagreement in both directions.
//
// **Elixir used to count GRAPHEMES** — `String.length/1` and Ecto's
// `validate_length/3` both count grapheme clusters — and was signed off as a
// residual on the theory that the two only diverge on combining sequences.
// That theory undercounts the exposure: NFD-normalised accented Latin, emoji
// ZWJ sequences and regional-indicator flags all hit it, and none is exotic.
// So elixir now counts code points too.  Ecto has no `:codepoints` count, which
// is why the changeset half hand-rolls `validate_change/3` closures carrying
// Ecto's own error tuples (`changeset-validators.ts`) instead of
// `validate_length/3` — both halves moved together, because moving one alone
// would make elixir disagree with itself.
// ---------------------------------------------------------------------------

/** JS/TS: spreading a string iterates it by code point. */
export function tsCodePointLength(recv: string): string {
  return `[...${recv}].length`;
}

/** C#: `EnumerateRunes()` yields one `Rune` per Unicode scalar value.
 *  `Count()` is `System.Linq`, which every emitted project has globally via
 *  the csproj's `<ImplicitUsings>enable</ImplicitUsings>`.
 *
 *  `s.length > 0` is a very common Loom invariant and `Count() > 0` trips
 *  **CA1827** ("use Any()") — a build error under the emitted csproj's
 *  `latest-recommended` analysis level plus CI's `/warnaserror`.  It is
 *  suppressed there (`NoWarn`, with this reason) rather than worked around
 *  with `Length - Count(char.IsLowSurrogate)`: that arithmetic form evaluates
 *  the receiver TWICE, which on a composed receiver (`s.drop(3).length`)
 *  duplicates the whole sub-expression in the emitted source. */
export function csCodePointLength(recv: string): string {
  return `${recv}.EnumerateRunes().Count()`;
}

/** Java: `codePoints()` is the JDK's own code-point stream — no import needed.
 *  Chosen over `codePointCount(0, s.length())` because that spells the
 *  receiver twice; `.count()` is a `long`, so the result is cast back to the
 *  `int` the IR gives `.length`, and self-parenthesized because the snippet
 *  lands in arbitrary expression slots. */
export function javaCodePointLength(recv: string): string {
  return `((int) ${recv}.codePoints().count())`;
}

/** Elixir: a charlist is a list of CODE POINTS, so `length/1` over it is the
 *  code-point count — `String.length/1` would count graphemes.  Chosen over
 *  `String.codepoints/1 |> length/1` because it spells the receiver once and
 *  needs no pipe (the snippet lands in arbitrary expression slots). */
export function elixirCodePointLength(recv: string): string {
  return `length(String.to_charlist(${recv}))`;
}
