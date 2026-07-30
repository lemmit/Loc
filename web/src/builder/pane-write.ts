// Pure half of the builder panes' write-back rule — react-free so the root
// vitest suite (which has no `web/node_modules` on CI) can import it directly.
// The hook that composes it with the rest of the rails lives in
// `pane-harness.ts`.  Same split as `live-source-tick.ts` / `use-live-source-tick.ts`.
//
// Two rules live here, and both used to be hand-copied into every pane — which
// is how `SystemBuilderV2Pane` shipped without the parse gate at all
// (`docs/audits/playground-file-mgmt-review-2026-07.md` defect #6):
//
//   * READ gate  — a pane must not derive its graph / inspector / write-back
//     targets from a RECOVERED AST.  Langium's error recovery keeps the
//     enclosing node and drops the sub-node it couldn't parse, so the CST
//     ranges the write-backs splice against no longer describe the user's
//     source.  `isParseOk` is that gate.
//   * WRITE gate — a candidate that doesn't parse is refused (visibly), never
//     committed.  `writeDecision` folds `edit-engine`'s `ifParses` and the
//     "helper returned null" case into one three-way answer.

/** True when the parse is CLEAN — i.e. the AST is trustworthy enough to derive
 *  a graph and to address CST ranges for write-backs. */
export function isParseOk(parsed: { readonly parserErrors: readonly unknown[] }): boolean {
  return parsed.parserErrors.length === 0;
}

export type WriteDecision =
  /** The candidate parses — hand it to the editor and clear any refusal. */
  | "commit"
  /** Nothing valid to write — show the refusal line rather than no-op silently. */
  | "refuse"
  /** The helper had nothing to do; not an error, so say nothing. */
  | "skip";

/** What a pane should do with a candidate source.
 *
 *  `next == null` means the helper that produced it wrote nothing.  For nearly
 *  every call site that IS the refusal (a rename/delete/splice that couldn't be
 *  performed — a silent no-op is indistinguishable from a lost click), which is
 *  why `nullMeans` defaults to `"refuse"`.  `BuilderPane`'s state-panel path is
 *  the one exception: null there means "the panel had no block to edit", which
 *  is an ordinary outcome, so it passes `"skip"`.
 *
 *  `gate` is `edit-engine`'s `ifParses` (injected so this module stays free of
 *  the Langium parser as well as of react). */
export function writeDecision(
  next: string | null,
  gate: (candidate: string) => string | null,
  nullMeans: "refuse" | "skip" = "refuse",
): WriteDecision {
  if (next == null) return nullMeans;
  return gate(next) == null ? "refuse" : "commit";
}
