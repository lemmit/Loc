// Debounced "the source changed under me" tick, shared by every builder pane.
//
// The panes derive expensive things from the `.ddd` text — a main-thread
// Langium parse plus a graph build plus (React Flow) a full canvas reflow.
// Keying those derivations off the `ctx` object identity meant ANY app state
// tick (pipeline step, diagnostics arriving, agent streaming a token, a test
// result landing) re-ran all of it.  They key off this counter instead, which
// only advances after the user has actually stopped typing.
//
// `BuilderPane` shipped this logic first; the other panes were the ones still
// re-deriving on `ctx`.  Extracted here so there is one implementation (and
// one debounce window) rather than four copies.

import { useEffect, useRef, useState } from "react";

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

/** Pure half of `useLiveSourceTick`, so the (otherwise timer-shaped) rule is
 *  unit-testable.
 *
 *  The very first tick a pane observes is a BASELINE, not a change: the pane's
 *  initial derive already read whatever source the user typed before the pane
 *  mounted, so re-deriving on that pre-mount tick would clobber a selection or
 *  an in-flight inline edit the user started during the debounce window right
 *  after switching to the pane.  Only ticks that ADVANCE past the baseline are
 *  real edits. */
export function reseedDecision(baseline: number | null, tick: number): ReseedDecision {
  if (baseline === null) return "baseline";
  return tick > baseline ? "schedule" : "ignore";
}

/** Debounced mirror of `ctx.editorSourceTick`.  Returns a counter that starts
 *  at 0 and bumps `LIVE_SYNC_DEBOUNCE_MS` after the user stops typing.
 *
 *  Deliberately separate from each pane's own `rev` (the Apply-path counter,
 *  which re-reads immediately and may remount): the live path must NOT remount,
 *  or the user's selection / open inputs would tear down mid-edit. */
export function useLiveSourceTick(editorSourceTick: number): number {
  const [liveTick, setLiveTick] = useState(0);
  const baselineRef = useRef<number | null>(null);
  useEffect(() => {
    const decision = reseedDecision(baselineRef.current, editorSourceTick);
    if (decision === "baseline") {
      baselineRef.current = editorSourceTick;
      return;
    }
    if (decision === "ignore") return;
    const t = window.setTimeout(() => setLiveTick((n) => n + 1), LIVE_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [editorSourceTick]);
  return liveTick;
}

/** Counter bumped when the editor is reseeded onto DIFFERENT content by
 *  something other than typing — a file-tab switch (`activeSourcePath`), an
 *  external change to the active file (`sourceEpoch`: history restore, import,
 *  another tab), or a new seed value (`initialSource`: example import,
 *  workspace switch).
 *
 *  Why a tick rather than putting those three straight in the derive memo:
 *  the panes read the live text through `ctx.getSource()`, which reads
 *  `sourceRef` — and App writes `sourceRef.current = initialSource` in an
 *  EFFECT.  A memo keyed directly on `initialSource` would therefore recompute
 *  during the render where the signal changed but the ref had NOT yet been
 *  updated, parse the previous text, and then never recompute — one generation
 *  stale, permanently.  Bumping a counter from an effect defers the re-derive
 *  by one render: React flushes child effects before parent effects, so by the
 *  time this `setState` re-renders, App's ref write has already landed.
 *
 *  The first run is a baseline (mount already derived from the current text). */
export function useExternalSourceTick(
  initialSource: string,
  activeSourcePath: string,
  sourceEpoch: number,
): number {
  const [tick, setTick] = useState(0);
  const seenRef = useRef(false);
  useEffect(() => {
    if (!seenRef.current) {
      seenRef.current = true;
      return;
    }
    setTick((n) => n + 1);
  }, [initialSource, activeSourcePath, sourceEpoch]);
  return tick;
}
