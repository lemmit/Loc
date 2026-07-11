// ---------------------------------------------------------------------------
// Breakpoint translation — the REVERSE of `src/trace/`.  `src/trace/`
// resolves a generated stack frame BACK to `.ddd` source
// (`resolveFrame`/`annotateTrace`); this resolves a `.ddd` source location
// FORWARD to every generated file:line it produced, over a parsed
// `.loom/sourcemap.json` — the primitive a future `ddd-dap` adapter needs to
// translate "set a breakpoint on this `.ddd` line" into the real
// backend-native breakpoint(s) to arm.
//
// See docs/proposals/source-map-and-debugging.md §6E and
// docs/plans/dap-node-debug.md (phase 8 first slice: this module). No DAP
// protocol wiring, no `@vscode/debugadapter` dependency, no
// `packages/ddd-dap` workspace here — those are glue built on top of this
// function later.
//
// Pure and dependency-free — no `fs`, browser-safe, mirroring `src/trace/`'s
// discipline exactly (same `readSource` injection convention as
// `annotateTrace`'s in `src/trace/annotate.ts`): the CLI/adapter reads +
// JSON.parses the map and reads the `.ddd` source text; this module never
// touches disk.
// ---------------------------------------------------------------------------

import type { SourceRef } from "../ir/types/origin.js";
import { resolveToSource } from "../ir/types/origin.js";
import {
  LineIndex,
  matchPath,
  type SourceMap,
  toOriginRef,
  type WireRegion,
} from "../trace/index.js";

/** One generated location a `.ddd` line maps forward to. */
export interface BreakpointTarget {
  /** The matched `map.files` key (generated file). */
  file: string;
  /** 1-based generated line — `region.target[0]`. */
  line: number;
  /** OPTIONAL 1-based generated START column — `region.targetCol[0]`, the
   *  fine expression-level column a real DAP `setBreakpoints` (V8
   *  `setBreakpointByUrl` takes url+line+column) needs to arm precisely.
   *  `undefined` for every column-less (coarse statement/structural)
   *  region — never synthesized, mirroring the reverse path's "print col
   *  only when `targetCol` is present" rule (`src/trace/annotate.ts`
   *  `locationWithColOf`). */
  column?: number;
  /** The matched region, kept for later `targetCol` (column-level) use. */
  region: WireRegion;
}

/** Standard half-open interval overlap: `[aStart, aEnd)` intersects
 *  `[bStart, bEnd)`. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Does `sourcePath` (a region origin's recorded path) refer to the same
 *  `.ddd` file as `dddPath` (the requested path)? Reuses `matchPath` (the
 *  same longest-suffix matcher `resolveFrame` uses) rather than a second
 *  hand-rolled comparison — `dddPath` plays the "candidate" role, matched
 *  against the single-element key list `[sourcePath]`. */
function samePath(sourcePath: string, dddPath: string): boolean {
  return matchPath(dddPath, [sourcePath]) !== undefined;
}

/**
 * Translate a `.ddd` source location (file + 1-based line) into every
 * generated file:line a parsed `.loom/sourcemap.json` maps it to — the
 * reverse of `resolveFrame` (`src/trace/resolve.ts`).
 *
 * Algorithm:
 *  1. Read the `.ddd` source via `readSource` and index it with
 *     `LineIndex`; unavailable source → `[]` (honest, no guess).
 *  2. Compute the requested line's byte range via the new
 *     `LineIndex.offsetOfLine` — `[offsetOfLine(dddLine),
 *     offsetOfLine(dddLine + 1))`, half-open (the last line's range
 *     extends to end of file).
 *  3. For every generated file's regions, resolve `region.origin` down to
 *     a `SourceRef` (a region whose origin has no resolvable source — a
 *     bare `derived` ref with no `from` chain — is skipped) and keep it
 *     iff its path matches `dddPath` (longest-suffix) AND its byte span
 *     overlaps the requested line's range.
 *  4. Sort narrowest-origin-span first (the inverse of `resolveFrame`'s
 *     narrowest-TARGET tie-break, since this direction fans out over
 *     origin spans rather than target spans; ties keep the earlier
 *     region) and de-dup by `{file, line, column}` (column being
 *     `region.targetCol[0]`, or the empty string when the region carries
 *     no `targetCol`), keeping the narrowest-span survivor of each key.
 *     Widening the key from `{file, line}` lets two distinct fine
 *     expression regions that land on the SAME generated line at
 *     DIFFERENT columns both survive as separate armable sites — for a
 *     column-less region the key's column suffix is always the same
 *     empty string, so collapsing there is byte-identical to before this
 *     column carried any weight.
 *
 * Returns every match — a `.ddd` line can host nested constructs (e.g. an
 * aggregate declaration and a narrower operation inside it both covering
 * the same line); the caller takes `[0]` for the most specific construct,
 * or all of them for every breakpoint site the line could arm.
 */
export function translateBreakpoint(
  map: SourceMap,
  dddPath: string,
  dddLine: number,
  readSource: (path: string) => string | undefined,
): BreakpointTarget[] {
  const text = readSource(dddPath);
  if (text === undefined) return [];

  const index = new LineIndex(text);
  const lineStart = index.offsetOfLine(dddLine);
  const lineEnd = index.offsetOfLine(dddLine + 1);

  interface Candidate {
    file: string;
    line: number;
    column: number | undefined;
    region: WireRegion;
    spanWidth: number;
    order: number;
  }

  const candidates: Candidate[] = [];
  let order = 0;
  for (const genFile of Object.keys(map.files)) {
    for (const region of map.files[genFile]!) {
      const origin = toOriginRef(region.origin);
      const source: SourceRef | undefined = resolveToSource(origin);
      if (!source) continue;
      if (!samePath(source.path, dddPath)) continue;
      if (!overlaps(source.span.start, source.span.end, lineStart, lineEnd)) continue;
      candidates.push({
        file: genFile,
        line: region.target[0],
        column: region.targetCol ? region.targetCol[0] : undefined,
        region,
        spanWidth: source.span.end - source.span.start,
        order: order++,
      });
    }
  }

  candidates.sort((a, b) => a.spanWidth - b.spanWidth || a.order - b.order);

  const seen = new Set<string>();
  const out: BreakpointTarget[] = [];
  for (const c of candidates) {
    const key = `${c.file}:${c.line}:${c.column ?? ""}`;
    if (seen.has(key)) continue; // already kept the narrowest-span survivor
    seen.add(key);
    out.push({
      file: c.file,
      line: c.line,
      ...(c.column !== undefined ? { column: c.column } : {}),
      region: c.region,
    });
  }
  return out;
}
