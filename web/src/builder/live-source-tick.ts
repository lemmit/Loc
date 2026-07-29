// Pure half of the live-source-tick rule — react-free so the root vitest
// suite (which has no web/node_modules on CI) can import it directly.
// The hooks that consume it live in `use-live-source-tick.ts`.

/** Debounce window for the text→pane live re-derive.  300 ms is the lower
 *  bound the original task gave; long enough to coalesce a typing storm in
 *  Monaco, short enough that an edit feels "live". */
export const LIVE_SYNC_DEBOUNCE_MS = 350;

export type ReseedDecision =
  /** First tick this pane has seen — record it as the baseline, derive nothing. */
  | "baseline"
  /** The tick advanced past the baseline — schedule a debounced re-derive. */
  | "schedule"
  /** Same tick (or older) as the baseline — nothing changed for this pane. */
  | "ignore";

/** The very first tick a pane observes is a BASELINE, not a change: the pane's
 *  initial derive already read whatever source the user typed before the pane
 *  mounted, so re-deriving on that pre-mount tick would clobber a selection or
 *  an in-flight inline edit the user started during the debounce window right
 *  after switching to the pane.  Only ticks that ADVANCE past the baseline are
 *  real edits. */
export function reseedDecision(baseline: number | null, tick: number): ReseedDecision {
  if (baseline === null) return "baseline";
  return tick > baseline ? "schedule" : "ignore";
}
