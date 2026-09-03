// Diagnostics-stream copy (M-T8.22 slice 5, audit M10): the `loom.diag` ring
// records internals — `react-error`, `unhandledrejection`, `hash 341b` — and
// the Output → Diagnostics stream used to show them verbatim.  This maps
// each reason to one sentence a user can act on.  The raw key stays in the
// row (as a chip) and in the copied crash report untouched:
// `crash-report.ts` is storage-blind and reason-blind by design, and the
// key is what a maintainer greps for.
//
// Pure strings; no React, no DOM — the root vitest suite drives it.

/** One sentence per ring reason.  Error classes say what broke and how far
 *  it reached; pressure breadcrumbs say plainly that they are not errors. */
export const DIAG_REASON_SENTENCE: Readonly<Record<string, string>> = {
  "react-error": "The whole playground crashed while rendering and showed the recovery screen.",
  "react-error-pane": "A panel crashed while rendering — the rest of the playground kept running.",
  "window-error": "An error was thrown outside React and nothing caught it.",
  unhandledrejection: "A background operation failed and nothing handled the failure.",
  "worker-error": "The build worker died or threw — a Generate may have been lost.",
  "died-in-phase":
    "The tab was killed part-way through a step (out of memory, or a background kill); this row is the only record of it.",
  hidden: "The tab went to the background — a memory / storage snapshot, not an error.",
  pagehide: "The page was hidden or unloaded — a memory / storage snapshot, not an error.",
};

/** The sentence for `reason`; an unknown reason gets a neutral fallback that
 *  still names it, never an empty row. */
export function humanizeDiagReason(reason: string): string {
  return DIAG_REASON_SENTENCE[reason] ?? `Diagnostics snapshot recorded (${reason}).`;
}

/** `hash 341b` → "URL hash 341 bytes — the model shared in the link".  A
 *  zero-length hash renders nothing (nothing was shared). */
export function humanizeHashLen(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return `URL hash ${bytes} bytes — the model shared in the link`;
}

/** Short badge text: the error classes read "error", the rest "snapshot". */
export function diagBadgeText(isCrash: boolean): string {
  return isCrash ? "error" : "snapshot";
}
