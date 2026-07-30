// The builder panes' shared safety-rail harness.
//
// The panes edit the `.ddd` text through a visual surface — `BuilderPane`
// (page canvas), `system-v2/SystemBuilderV2Pane` (the model builder, whose
// read-only `OverviewCanvas` takes the same rails) and
// `requirements/RequirementsPane` — and every one of them needs the SAME four
// rails:
//
//   1. re-derive when (and only when) the source under `getSource()` moved —
//      this pane's own commit (`rev`), the debounced editor tick (`liveTick`),
//      and the external reseed signals (`externalTick`);
//   2. a READ gate on the parse, so nothing derives from a recovered AST;
//   3. a WRITE gate, so a candidate the parser rejects is never committed;
//   4. a visible refusal when a write is refused, instead of a silent no-op.
//
// They used to carry a parallel copy each (four, back when a second model pane
// still shipped), and the copies drifted: v2 shipped without rail 2 entirely
// (`docs/audits/playground-file-mgmt-review-2026-07.md` defect #6), which
// #2287 then had to fix twice.  One implementation, every consumer — mission
// M-T8.13 phase 1.  (Phases 2–4 then retired the v1 model pane into v2, so
// there are three consumers and one fewer copy to drift; the completeness pin
// DISCOVERS panes, so nothing about it had to change.)
//
// The pure decision half lives in `pane-write.ts` (react-free, unit-tested);
// this module is the react composition over it.

import { useMemo, useState } from "react";
import { ifParses } from "./edit-engine";
import { type DddParse, parseDdd } from "./parse";
import { type Refusal, useRefusal } from "./refusal";
import { isParseOk, writeDecision } from "./pane-write";
import { useExternalSourceTick, useLiveSourceTick } from "./use-live-source-tick";

/** The slice of `LayoutCtx` the harness reads.  Structural on purpose: the
 *  harness has no business seeing the other ~60 fields, and a narrow shape is
 *  what makes it testable without an App. */
export interface PaneSourceCtx {
  /** The live editor source (reflects unsaved edits). */
  getSource: () => string;
  onSourceChange: (text: string, origin?: "editor" | "builder") => void;
  /** Bumped on every editor keystroke; debounced into `liveTick`. */
  editorSourceTick: number;
  initialSource: string;
  activeSourcePath: string;
  sourceEpoch: number;
}

export interface PaneHarnessOptions<A extends unknown[]> {
  /** Opt out of the external-reseed signal (`BuilderPane`: an external reseed
   *  remounts its craft Editor by other means, and folding the tick into the
   *  parse memo would deserialize over the user's in-flight panel edits).
   *  Defaults to true — every pane that renders its own view of the model
   *  wants it. */
  externalReseed?: boolean;
  /** Replace the commit half of `apply`.  Receives the harness's own committer
   *  so a staging wrapper can still perform the write (v1's preview mode stages
   *  the diff instead of committing).  Extra arguments are forwarded from the
   *  `apply` / `applyOrRefuse` call. */
  onCommit?: (next: string, commit: (next: string) => void, ...args: A) => void;
}

export interface PaneHarness<A extends unknown[]> {
  /** The memoised parse of the current source. */
  parsed: DddParse;
  /** READ gate — false on a recovered AST.  Derivations that address CST
   *  ranges (graphs, inspectors, statement views) must check it. */
  parseOk: boolean;
  /** This pane's commit counter; part of the parse memo's dep set, and usable
   *  as a remount key. */
  rev: number;
  /** Advance `rev` without writing (rare — a pane that mutated the source by
   *  some other route and needs to re-derive). */
  bumpRev: () => void;
  /** Debounced "the user typed" tick. */
  liveTick: number;
  /** "The editor was reseeded onto different content" tick; pinned at 0 when
   *  `externalReseed: false`. */
  externalTick: number;
  refusal: Refusal;
  /** Write a candidate source.  WRITE gate: refused (visibly) unless it still
   *  parses. */
  apply: (next: string, ...args: A) => void;
  /** `apply`, treating a null candidate as a refusal — the shape every
   *  `edit-engine`-backed helper returns. */
  applyOrRefuse: (next: string | null, ...args: A) => void;
  /** `apply`, treating a null candidate as "nothing to do" (silent). */
  applyOrSkip: (next: string | null, ...args: A) => void;
  /** Commit an ALREADY-gated candidate (v1's staged-preview confirm).  Bypasses
   *  the write gate — only for text that came out of `apply`. */
  commit: (next: string) => void;
}

/** Frozen stand-in for the external-reseed inputs when a pane opts out.  The
 *  hook still runs (rules of hooks) but never observes a change, so it never
 *  bumps and never re-renders the pane. */
const NO_EXTERNAL_RESEED = { initialSource: "", activeSourcePath: "", sourceEpoch: 0 };

export function usePaneHarness<A extends unknown[] = []>(
  ctx: PaneSourceCtx,
  options: PaneHarnessOptions<A> = {},
): PaneHarness<A> {
  const [rev, setRev] = useState(0);
  const bumpRev = (): void => setRev((r) => r + 1);

  // What a pane actually reads is the SOURCE TEXT, not the ctx object.
  // Deriving on `ctx` re-ran a main-thread Langium parse + a graph build + a
  // full React Flow reflow on every unrelated app tick (a pipeline step, a
  // diagnostic arriving, an agent token streaming, a test result landing).
  // These three are the complete set of signals that the text moved:
  //   rev          — this pane's own Apply committed an edit
  //   liveTick     — the user typed in Monaco (debounced ~350 ms)
  //   externalTick — the editor was reseeded onto different content by
  //                  something else (file-tab switch, external change to the
  //                  active file, example import, workspace switch)
  const liveTick = useLiveSourceTick(ctx.editorSourceTick);
  const external = options.externalReseed === false ? NO_EXTERNAL_RESEED : ctx;
  const externalTick = useExternalSourceTick(
    external.initialSource,
    external.activeSourcePath,
    external.sourceEpoch,
  );

  const getSource = ctx.getSource;
  const parsed = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `getSource` reads a ref; the deps below are the change signals.
    () => parseDdd(getSource()),
    [getSource, rev, liveTick, externalTick],
  );
  const parseOk = isParseOk(parsed);

  const refusal = useRefusal();

  /** Hand a candidate to the editor and re-derive.  No gate — callers reach it
   *  through `apply` (or knowingly, via the returned `commit`). */
  const commit = (next: string): void => {
    ctx.onSourceChange(next, "builder");
    bumpRev();
  };

  const decide = (next: string | null, nullMeans: "refuse" | "skip", args: A): void => {
    switch (writeDecision(next, ifParses, nullMeans)) {
      case "refuse":
        refusal.refuse();
        return;
      case "skip":
        return;
      case "commit": {
        refusal.clear();
        // `next` is non-null on a "commit" decision by construction.
        const text = next as string;
        if (options.onCommit) options.onCommit(text, commit, ...args);
        else commit(text);
      }
    }
  };

  return {
    parsed,
    parseOk,
    rev,
    bumpRev,
    liveTick,
    externalTick,
    refusal,
    apply: (next: string, ...args: A): void => decide(next, "refuse", args),
    applyOrRefuse: (next: string | null, ...args: A): void => decide(next, "refuse", args),
    applyOrSkip: (next: string | null, ...args: A): void => decide(next, "skip", args),
    commit,
  };
}
