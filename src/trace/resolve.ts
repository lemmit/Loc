// ---------------------------------------------------------------------------
// Frame → source resolution — the second step of `ddd trace`.  Matches a
// `ParsedFrame` (frames.ts) against a parsed `.loom/sourcemap.json` and
// walks the `OriginRef` chain back to real `.ddd` source, reusing
// `resolveToSource` from `src/ir/types/origin.ts` (the same layering as
// `src/verify/` consuming `ir/` types — see CLAUDE.md's pipeline note).
//
// Pure and dependency-free — no `fs`. The CLI reads + JSON.parses the map
// file and hands the parsed object in here.
// ---------------------------------------------------------------------------

import type { OriginRef, SourceRef } from "../ir/types/origin.js";
import { resolveToSource } from "../ir/types/origin.js";
import type { ParsedFrame } from "./frames.js";

// `src/system/sourcemap.ts` renders the artifact from a `SourceMapRecorder`
// but keeps its wire-shape interfaces private (deliberately: the artifact's
// published contract is independent of the internal `OriginRef` type,
// see that file's `renderOrigin` doc comment). `trace/` only ever consumes
// the published JSON, so the wire shape is re-declared here rather than
// imported — this is the one place that must stay in sync with the wire
// format `renderSourceMap` emits.
//
// The one deliberate shape difference from `OriginRef`: `span` is a
// `[start, end]` tuple on the wire (JSON has no tuple/object distinction,
// but this matches what's actually emitted), not the `{start, end}` object
// the IR type uses — `toOriginRef` below bridges the two so
// `resolveToSource` can be reused verbatim.

export interface WireSourceRef {
  kind: "source";
  path: string;
  span: [number, number];
}

export interface WireMacroRef {
  kind: "macro";
  macro: string;
  call: WireSourceRef;
  inner?: WireOriginRef;
}

export interface WireDerivedRef {
  kind: "derived";
  reason: string;
  from?: WireOriginRef;
}

export type WireOriginRef = WireSourceRef | WireMacroRef | WireDerivedRef;

export interface WireRegion {
  target: [number, number];
  origin: WireOriginRef;
  construct?: string;
  /** OPTIONAL real generated column range — mirrors `SourceMapRegion.targetCol`
   *  (`src/generator/_trace/sourcemap.ts`) / `src/system/sourcemap.ts`'s wire
   *  copy verbatim (1-based, half-open `[startCol, endCol)`). Deliberately
   *  re-declared rather than imported — same decoupling rationale as the
   *  rest of this file's wire types (see the module comment above): `trace/`
   *  only ever consumes the published JSON. */
  targetCol?: [number, number];
}

/** The parsed shape of `.loom/sourcemap.json` — see `src/system/sourcemap.ts`. */
export interface SourceMap {
  version: number;
  sources: string[];
  files: Record<string, WireRegion[]>;
}

/** Convert a wire origin ref (JSON `span` tuple) into the IR's `OriginRef`
 *  (`span` object), so `resolveToSource` can be reused as-is. Exported (not
 *  just an internal helper) so `src/dap/breakpoints.ts` can walk the same
 *  origin chain going the opposite direction (`.ddd` line → generated
 *  location) without hand-rolling a second wire→IR bridge. */
export function toOriginRef(o: WireOriginRef): OriginRef {
  switch (o.kind) {
    case "source":
      return { kind: "source", path: o.path, span: { start: o.span[0], end: o.span[1] } };
    case "macro":
      return {
        kind: "macro",
        macro: o.macro,
        call: toOriginRef(o.call) as SourceRef,
        ...(o.inner ? { inner: toOriginRef(o.inner) } : {}),
      };
    case "derived":
      return {
        kind: "derived",
        reason: o.reason,
        ...(o.from ? { from: toOriginRef(o.from) } : {}),
      };
  }
}

/** Split a path on either slash style and drop empty segments (leading
 *  `/`, doubled separators). */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** Longest-suffix match of `candidate` against `keys` (`map.files` keys),
 *  compared path-segment by path-segment from the end — so `order.ts`
 *  never spuriously matches `border.ts`, and an absolute local path
 *  matches an out-dir-relative map key on their shared tail.  Returns
 *  `undefined` when nothing matches, or when the longest match is tied
 *  across more than one key (ambiguous — never guess). */
export function matchPath(candidate: string, keys: readonly string[]): string | undefined {
  const cSeg = segments(candidate);
  let best: string | undefined;
  let bestLen = 0;
  let tied = false;
  for (const key of keys) {
    const kSeg = segments(key);
    let n = 0;
    while (
      n < cSeg.length &&
      n < kSeg.length &&
      cSeg[cSeg.length - 1 - n] === kSeg[kSeg.length - 1 - n]
    ) {
      n++;
    }
    if (n === 0) continue;
    if (n > bestLen) {
      bestLen = n;
      best = key;
      tied = false;
    } else if (n === bestLen) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/** Java frames carry no directory, only the FQN — derive the
 *  `<package-path>/<File>.java` suffix from it. `frame.javaFqn` is
 *  `pkg.pkg.Class.method`; dropping the last two dotted segments (method,
 *  then class simple name) leaves the package, and the actual file
 *  basename (already parsed from the parens, so inner-class frames like
 *  `Foo$Inner` still resolve to `Foo.java`) is appended verbatim. */
function candidatePathFor(frame: ParsedFrame): string | undefined {
  if (!frame.file) return undefined;
  if (!frame.javaFqn) return frame.file;
  const parts = frame.javaFqn.split(".");
  const pkgParts = parts.slice(0, -2);
  return pkgParts.length > 0 ? `${pkgParts.join("/")}/${frame.file}` : frame.file;
}

export interface Resolution {
  /** The matched `map.files` key. */
  path: string;
  region: WireRegion;
  origin: OriginRef;
  /** The chain walked to a real `.ddd` span — `undefined` only for a bare
   *  `derived` ref with no `from` chain (see `resolveToSource`). */
  source?: SourceRef;
}

/** Resolve one parsed frame against a loaded source map: path match
 *  (longest suffix), then region match, then the origin chain walk.
 *
 *  Region match is layered:
 *   - IF the frame carries a column (V8/Node only, see `frames.ts`) AND
 *     some line-matching region carries a `targetCol` containing it
 *     (`targetCol[0] <= col < targetCol[1]`, half-open): pick the
 *     NARROWEST such region by `targetCol` width — the fine
 *     expression-level origin, the whole point of this slice. Ties keep
 *     the earlier region.
 *   - ELSE (no column, or a column matching no `targetCol` region): fall
 *     back to today's line-narrowest walk — the NARROWEST region whose
 *     target range contains the frame's line — but EXCLUDING every
 *     `targetCol`-bearing region from consideration. A fine expression
 *     region must never win a line-width contest by accident when the
 *     column gives no evidence for it; this exclusion is what keeps every
 *     column-less resolution byte-identical to before `targetCol` existed
 *     (see test/system/trace-roundtrip.test.ts). Ties keep the earlier
 *     region.
 *
 *  Which path won is derivable from the result: `region.targetCol !==
 *  undefined` means the column-aware path matched (no separate
 *  `viaColumn` field needed).
 *
 *  Returns `undefined` when the frame doesn't land in any mapped
 *  file/region — the frame passes through unannotated. */
export function resolveFrame(frame: ParsedFrame, map: SourceMap): Resolution | undefined {
  const line = frame.line;
  if (line === undefined) return undefined;
  const candidate = candidatePathFor(frame);
  if (!candidate) return undefined;

  const path = matchPath(candidate, Object.keys(map.files));
  if (!path) return undefined;

  const lineMatches = map.files[path]!.filter((r) => line >= r.target[0] && line <= r.target[1]);

  let region: WireRegion | undefined;
  const col = frame.col;
  if (col !== undefined) {
    let colWidth = Number.POSITIVE_INFINITY;
    for (const r of lineMatches) {
      if (!r.targetCol) continue;
      if (col < r.targetCol[0] || col >= r.targetCol[1]) continue;
      const width = r.targetCol[1] - r.targetCol[0];
      if (!region || width < colWidth) {
        region = r;
        colWidth = width;
      }
    }
  }

  if (!region) {
    for (const r of lineMatches) {
      if (r.targetCol) continue;
      if (!region || r.target[1] - r.target[0] < region.target[1] - region.target[0]) region = r;
    }
  }
  if (!region) return undefined;

  const origin = toOriginRef(region.origin);
  return { path, region, origin, source: resolveToSource(origin) };
}
