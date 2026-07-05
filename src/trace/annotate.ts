// ---------------------------------------------------------------------------
// `annotateTrace` — the top-level `ddd trace` operation.  Splices a
// human-readable annotation onto every stack-frame line a `.loom/
// sourcemap.json` can resolve; unmatched frames (and every non-frame line —
// headers, exception messages, blank lines) pass through byte-identical.
//
// Pure and dependency-free — no `fs`. `readSource` is an injected lookup
// (`path -> text | undefined`) so the CLI can wire it to `fs.readFileSync`
// while this module stays browser-safe. When it's omitted, or returns
// `undefined` for a given path (source file missing/moved), the location
// degrades to a byte-span rather than crashing or guessing a line number.
// ---------------------------------------------------------------------------

import type { SourceRef } from "../ir/types/origin.js";
import { parseFrames } from "./frames.js";
import { type Resolution, resolveFrame, type SourceMap } from "./resolve.js";

/** Maps a source offset to its 1-based line number. Built once per
 *  distinct source text `annotateTrace` needs to convert (the module
 *  never re-scans the same text for every frame). */
export class LineIndex {
  private readonly starts: number[];

  constructor(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") starts.push(i + 1);
    }
    this.starts = starts;
  }

  /** 1-based line number containing byte offset `offset`. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  }
}

function locationOf(source: SourceRef, indexFor: (path: string) => LineIndex | undefined): string {
  const index = indexFor(source.path);
  if (index) {
    return `${source.path}:${index.lineOf(source.span.start)}`;
  }
  return `${source.path}@bytes ${source.span.start}..${source.span.end}`;
}

/** Render the arrow-annotation appended to a resolved frame's line —
 *  `<construct?>  <marker?>  (<location>)`, e.g.:
 *
 *    Orders.Order  (main.ddd:14)
 *    Cart.CartPage  [macro scaffold]  (main.ddd:22)
 *    [synthetic: auto-findAll]
 */
function describe(res: Resolution, indexFor: (path: string) => LineIndex | undefined): string {
  const bits: string[] = [];
  if (res.region.construct) bits.push(res.region.construct);
  if (res.origin.kind === "macro") bits.push(`[macro ${res.origin.macro}]`);
  else if (res.origin.kind === "derived") bits.push(`[synthetic: ${res.origin.reason}]`);

  const label = bits.join("  ");
  const loc = res.source ? `(${locationOf(res.source, indexFor)})` : "";
  return [label, loc].filter(Boolean).join("  ");
}

/**
 * Annotate a crash log / stack trace with the `.ddd` construct + source
 * location each recognized frame maps to, via a parsed `.loom/sourcemap.json`.
 * Exit-code / IO concerns (missing map, unreadable log) live in the CLI —
 * this function is pure best-effort: every frame it can't resolve is left
 * exactly as it appeared in `logText`.
 */
export function annotateTrace(
  logText: string,
  map: SourceMap,
  readSource?: (path: string) => string | undefined,
): string {
  const lines = logText.split("\n");
  const byLineIndex = new Map(parseFrames(logText).map((f) => [f.lineIndex, f]));

  // One read + one LineIndex per distinct source path, however many frames
  // resolve into it (`null` caches a miss so a missing file is probed once).
  const indexCache = new Map<string, LineIndex | null>();
  const indexFor = (p: string): LineIndex | undefined => {
    let cached = indexCache.get(p);
    if (cached === undefined) {
      const text = readSource?.(p);
      cached = text === undefined ? null : new LineIndex(text);
      indexCache.set(p, cached);
    }
    return cached ?? undefined;
  };

  return lines
    .map((line, i) => {
      const frame = byLineIndex.get(i);
      if (!frame) return line;
      const resolution = resolveFrame(frame, map);
      if (!resolution) return line;
      return `${line}  →  ${describe(resolution, indexFor)}`;
    })
    .join("\n");
}
