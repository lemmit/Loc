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
}

/** The parsed shape of `.loom/sourcemap.json` — see `src/system/sourcemap.ts`. */
export interface SourceMap {
  version: number;
  sources: string[];
  files: Record<string, WireRegion[]>;
}

/** Convert a wire origin ref (JSON `span` tuple) into the IR's `OriginRef`
 *  (`span` object), so `resolveToSource` can be reused as-is. */
function toOriginRef(o: WireOriginRef): OriginRef {
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
 *  (longest suffix), then region match (the first region whose target
 *  range contains the frame's line), then the origin chain walk. Returns
 *  `undefined` when the frame doesn't land in any mapped file/region —
 *  the frame passes through unannotated. */
export function resolveFrame(frame: ParsedFrame, map: SourceMap): Resolution | undefined {
  if (frame.line === undefined) return undefined;
  const candidate = candidatePathFor(frame);
  if (!candidate) return undefined;

  const path = matchPath(candidate, Object.keys(map.files));
  if (!path) return undefined;

  const region = map.files[path]!.find(
    (r) => frame.line! >= r.target[0] && frame.line! <= r.target[1],
  );
  if (!region) return undefined;

  const origin = toOriginRef(region.origin);
  return { path, region, origin, source: resolveToSource(origin) };
}
