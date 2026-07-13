// ---------------------------------------------------------------------------
// The DAP `stackTrace` remap core — the REVERSE twin of
// `src/dap/set-breakpoints.ts` (docs/old/proposals/source-map-and-debugging.md
// §6E, docs/old/plans/dap-node-debug.md phase 8, Milestone 25). Where
// `resolveSetBreakpoints` remaps a `.ddd` breakpoint FORWARD to the
// generated location the target debugger should arm, `remapStackFrames`
// remaps the debugged runtime's reported stack frames BACKWARD: each frame
// arrives in GENERATED coordinates (the target debugger's own report) and is
// rewritten to `.ddd` source, by reusing the already-shipped `resolveFrame`
// (`src/trace/resolve.ts`) + `LineIndex` (`src/trace/annotate.ts`).
//
// This is the "pure core -> thin protocol adapter" precedent `src/trace/`
// and `src/dap/set-breakpoints.ts` already set: the eventual
// `DebugSession.stackTraceRequest(response, args)` handler becomes
// `response.body = { stackFrames: remapStackFrames(rawFrames, map,
// readSource) }`. Pure, dependency-free, browser-safe — no `fs`, no DAP
// protocol I/O, no `@vscode/debugadapter` dependency.
// ---------------------------------------------------------------------------

import { LineIndex } from "../trace/annotate.js";
import type { SourceMap } from "../trace/resolve.js";
import { resolveFrame } from "../trace/resolve.js";
import type { DapStackFrame } from "./dap-protocol.js";

/**
 * Remap a debugged runtime's reported stack frames (GENERATED coordinates)
 * back to `.ddd` source, one output frame per input frame, SAME order and
 * length (the adapter returns them 1:1 to the editor).
 *
 * For each input frame, a `ParsedFrame` `{ file: frame.source?.path, line:
 * frame.line, col: frame.column }` is built (no `javaFqn` — that's a
 * text-frame-only concern) and resolved via `resolveFrame`. The frame
 * passes through UNCHANGED (still pointing at its generated location) when:
 * - `frame.source?.path` is undefined,
 * - `resolveFrame` finds no covering region, or
 * - the matched region's origin doesn't chain to real `.ddd` source (a bare
 *   `derived` origin with no `from`), or
 * - `readSource` returns `undefined` for the resolved `.ddd` path (source
 *   text unavailable — never guess).
 *
 * Only a fully-resolved frame is rewritten: `source.path` becomes the `.ddd`
 * path, `line`/`column` become the 1-based `.ddd` location of the resolved
 * span's start (via `LineIndex.lineOf`/`colOf` — no adjustment, DAP is
 * 1-based too). `id`/`name` are kept verbatim. Column awareness falls out of
 * `resolveFrame` reusing its narrowest-`targetCol` pick when the input frame
 * carries a column — no new column logic here.
 *
 * `LineIndex` is cached per resolved `.ddd` path within one call (a stack
 * has many frames in the same source), built lazily.
 */
export function remapStackFrames(
  frames: readonly DapStackFrame[],
  map: SourceMap,
  readSource: (path: string) => string | undefined,
): DapStackFrame[] {
  const indexCache = new Map<string, LineIndex>();
  const indexFor = (path: string): LineIndex | undefined => {
    let cached = indexCache.get(path);
    if (!cached) {
      const text = readSource(path);
      if (text === undefined) return undefined;
      cached = new LineIndex(text);
      indexCache.set(path, cached);
    }
    return cached;
  };

  return frames.map((frame) => {
    const file = frame.source?.path;
    if (file === undefined) return frame;

    const resolution = resolveFrame(
      { lineIndex: 0, file, line: frame.line, col: frame.column },
      map,
    );
    if (!resolution?.source) return frame;

    const index = indexFor(resolution.source.path);
    if (!index) return frame;

    return {
      ...frame,
      source: { path: resolution.source.path },
      line: index.lineOf(resolution.source.span.start),
      column: index.colOf(resolution.source.span.start),
    };
  });
}
