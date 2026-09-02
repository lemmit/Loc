// The SARGABLE PREFILTER half of the hierarchical-tenancy subtree read
// (M-T3.17).  One file so the five language spellings of "escape the anchor,
// append `.%`" sit side by side and can be read against each other — the
// escaping is the only part of the predicate a backend could get wrong, and a
// per-backend copy scattered across five emitters is how five spellings drift.
//
// Read `DEEP_SCOPE_SEMANTICS` (src/ir/util/tenant-stance.ts) first: the LIKE
// these helpers build is a PREFILTER, ANDed with the unchanged anchored
// `strpos(col, anchor || '.') = 1` recheck.  That is what makes the escaping
// non-load-bearing for correctness — an unescaped `%`/`_` only widens the
// prefilter, and the recheck still decides the row, so the `orgXa.leak`
// wildcard trap cannot come back.  The escaping is here for SELECTIVITY: the
// Postgres planner extracts the pattern's fixed prefix (escapes included) and
// turns it into an index range over the `data_key text_pattern_ops` index, so
// the more of the anchor that lands in the prefix, the tighter the scan.

import {
  DATA_KEY_LIKE_ESCAPE,
  DATA_KEY_LIKE_ESCAPED_CHARS,
  DATA_KEY_PATH_DELIMITER,
} from "../../ir/util/tenant-stance.js";

/** The pattern suffix every spelling appends: the path delimiter plus the
 *  "anything below it" wildcard (`.%`). */
export const SUBTREE_LIKE_SUFFIX = DATA_KEY_PATH_DELIMITER + "%";

/** `[!%_]` — the escapable set as a regex character class, for the languages
 *  that escape with one regex pass (TypeScript).  Every member is
 *  regex-special-free inside a class except `]`/`^`/`\`, none of which are in
 *  the set, so no class-escaping is needed. */
const LIKE_CHAR_CLASS = `[${DATA_KEY_LIKE_ESCAPED_CHARS.join("")}]`;

/** A chain of literal replace calls, one per escapable character, applied in
 *  {@link DATA_KEY_LIKE_ESCAPED_CHARS} order (the escape character FIRST — see
 *  the constant).  `call(from, to)` spells one link in the target language. */
function replaceChain(recv: string, call: (from: string, to: string) => string): string {
  let out = recv;
  for (const ch of DATA_KEY_LIKE_ESCAPED_CHARS) {
    out += call(ch, DATA_KEY_LIKE_ESCAPE + ch);
  }
  return out;
}

/** TypeScript (drizzle + MikroORM): one regex pass, `$&` re-emitting the
 *  matched metacharacter after the escape. */
export function tsSubtreeLikePattern(anchor: string): string {
  return (
    `(${anchor}).replace(/${LIKE_CHAR_CLASS}/g, ${JSON.stringify(`${DATA_KEY_LIKE_ESCAPE}$&`)}) + ` +
    JSON.stringify(SUBTREE_LIKE_SUFFIX)
  );
}

/** C# (EF Core query filter).  `string.Replace(string, string)` is ordinal and
 *  literal, and the whole chain is principal-only — it contains no reference to
 *  the entity parameter, so EF funcletizes it to a single bound parameter
 *  instead of trying to translate `replace()` into SQL. */
export function csSubtreeLikePattern(anchor: string): string {
  return (
    replaceChain(anchor, (from, to) => `.Replace(${JSON.stringify(from)}, ${JSON.stringify(to)})`) +
    ` + ${JSON.stringify(SUBTREE_LIKE_SUFFIX)}`
  );
}

/** Java (the JPA Criteria `tenantScope` Specification).
 *  `String.replace(CharSequence, CharSequence)` is literal, not regex.  The
 *  caller has already null-guarded the anchor. */
export function javaSubtreeLikePattern(anchor: string): string {
  return (
    replaceChain(anchor, (from, to) => `.replace(${JSON.stringify(from)}, ${JSON.stringify(to)})`) +
    ` + ${JSON.stringify(SUBTREE_LIKE_SUFFIX)}`
  );
}

/** Spring Data SpEL (the `@Query` JPQL bind parameter).  Every link is
 *  SAFE-NAVIGATED (`?.`) and the suffix is appended with `concat` rather than
 *  `+`, so an absent principal yields `null` — SpEL's `+` would stringify it to
 *  `"null"` and hand the prefilter a pattern that matches something.  A null
 *  pattern makes `LIKE NULL` unknown, i.e. fail-closed, matching the anchored
 *  `locate(...)` recheck beside it.  SpEL has no char literal: `'!'` is a
 *  one-character String, which selects `replace(CharSequence, CharSequence)`. */
export function spelSubtreeLikePattern(anchor: string): string {
  const chain = DATA_KEY_LIKE_ESCAPED_CHARS.map(
    (ch) => `?.replace('${ch}', '${DATA_KEY_LIKE_ESCAPE}${ch}')`,
  ).join("");
  return `${anchor}${chain}?.concat('${SUBTREE_LIKE_SUFFIX}')`;
}

/** Python (SQLAlchemy find predicate).  `str.replace` is literal. */
export function pySubtreeLikePattern(anchor: string): string {
  return (
    replaceChain(anchor, (from, to) => `.replace(${JSON.stringify(from)}, ${JSON.stringify(to)})`) +
    ` + ${JSON.stringify(SUBTREE_LIKE_SUFFIX)}`
  );
}

/** Elixir (Ecto fragment parameter).  `String.replace/3` with a binary pattern
 *  is literal; the chain is written as a pipeline so a nil anchor is turned
 *  into `""` by the caller's interpolation before it reaches here. */
export function exSubtreeLikePattern(anchor: string): string {
  const chain = DATA_KEY_LIKE_ESCAPED_CHARS.map(
    (ch) =>
      ` |> String.replace(${JSON.stringify(ch)}, ${JSON.stringify(DATA_KEY_LIKE_ESCAPE + ch)})`,
  ).join("");
  return `(${anchor}${chain}) <> ${JSON.stringify(SUBTREE_LIKE_SUFFIX)}`;
}

/** The `ESCAPE '<c>'` clause as it appears inside a raw SQL string. */
export const SQL_LIKE_ESCAPE_CLAUSE = `escape '${DATA_KEY_LIKE_ESCAPE}'`;
