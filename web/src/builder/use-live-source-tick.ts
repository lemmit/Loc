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
//
// Since M-T8.13 phase 1 the panes no longer call these directly — `pane-harness.ts`
// composes them with the parse gate, the write gate and the refusal line into
// the one `usePaneHarness(ctx)` all four panes take.

import { useEffect, useRef, useState } from "react";
import { LIVE_SYNC_DEBOUNCE_MS, reseedDecision } from "./live-source-tick";

export { LIVE_SYNC_DEBOUNCE_MS, reseedDecision, type ReseedDecision } from "./live-source-tick";

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
