// ---------------------------------------------------------------------------
// Edit distance + "did you mean" — the one place Loom decides whether two
// names are close enough to suggest one for the other.
//
// The metric is OPTIMAL STRING ALIGNMENT (Damerau-Levenshtein restricted to
// adjacent transpositions), not plain Levenshtein, because the typo this is
// most often asked about is a swap: `reakt` for `react`, `pyhton` for
// `python`.  Plain Levenshtein scores a swap 2 — the same as two unrelated
// substitutions — so a threshold tight enough to keep suggestions relevant
// throws the swap away.  OSA scores it 1 and the suggestion survives.
//
// Layering: `src/util/` because the consumers span layers — the parser error
// reporter (`src/language/parse-errors.ts`, phase ①) and the AST validators.
// Keep it import-free so it stays browser-safe for the playground.
// ---------------------------------------------------------------------------

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent
 *  transpositions).  Symmetric, ≥ 0, and never greater than plain
 *  Levenshtein. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Three rolling rows: `prev2` is needed only for the transposition step.
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2]! + 1);
      }
      cur[j] = best;
    }
    const spent = prev2;
    prev2 = prev;
    prev = cur;
    cur = spent;
  }
  return prev[n]!;
}

/** How far apart two names may be and still read as the same intent.
 *  Deliberately tight: one edit for a short name, two once there is enough
 *  word left for a second slip to still be a slip. */
export function withinTypoDistance(word: string, candidate: string, distance: number): boolean {
  const len = Math.max(word.length, candidate.length);
  if (len <= 3) return distance <= 1;
  return distance <= 2;
}

/**
 * The single closest candidate to `word`, or `undefined` when nothing is
 * close enough.  Ties keep the FIRST candidate in iteration order, so the
 * suggestion is stable for a caller that passes candidates in grammar /
 * declaration order.
 *
 * A candidate equal to `word` is skipped — this answers "what did you mean
 * instead", so an exact match is never a suggestion.
 */
export function nearestName(word: string, candidates: Iterable<string>): string | undefined {
  if (word.length === 0) return undefined;
  const lower = word.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === word || candidate.length === 0) continue;
    // A pure case slip (`React` for `react`) is the closest kind of match
    // there is and must beat any one-edit rival, so it short-circuits.
    if (candidate.toLowerCase() === lower) return candidate;
    const d = editDistance(word, candidate);
    if (d < bestDistance && withinTypoDistance(word, candidate, d)) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}
