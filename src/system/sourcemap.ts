import type { SourceMapRecorder, SourceMapRegion } from "../generator/_trace/sourcemap.js";
import type { OriginRef } from "../ir/types/origin.js";

// ---------------------------------------------------------------------------
// .loom/sourcemap.json — the construct-granular map from generated file
// regions back to the `.ddd` source (or macro-call, or derivation) that
// produced them.  Sibling of wire-spec.ts / traceability.ts: a pure
// derivation over data the recorder already collected, emitted once at
// the output root.  Opt-in — only rendered when `--sourcemap` is passed
// (see src/system/index.ts).
//
// See docs/plans/source-map-debug-kickoff.md §3 for the pinned wire shape.
// ---------------------------------------------------------------------------

interface WireSpan {
  start: number;
  end: number;
}

interface WireSourceRef {
  kind: "source";
  path: string;
  span: [number, number];
}

interface WireMacroRef {
  kind: "macro";
  macro: string;
  call: WireSourceRef;
  inner?: WireOriginRef;
}

interface WireDerivedRef {
  kind: "derived";
  reason: string;
  from?: WireOriginRef;
}

type WireOriginRef = WireSourceRef | WireMacroRef | WireDerivedRef;

interface WireRegion {
  target: [number, number];
  origin: WireOriginRef;
  construct?: string;
}

/** Serialize an `OriginRef` into its wire shape.  Deliberately hand-rolled
 *  (not `JSON.stringify`'d raw) so the artifact's wire shape stays
 *  independent of the internal IR type — an `origin.ts` field rename
 *  doesn't silently change the published contract. */
function renderOrigin(origin: OriginRef): WireOriginRef {
  switch (origin.kind) {
    case "source":
      return renderSourceRef(origin);
    case "macro":
      return {
        kind: "macro",
        macro: origin.macro,
        call: renderSourceRef(origin.call),
        ...(origin.inner ? { inner: renderOrigin(origin.inner) } : {}),
      };
    case "derived":
      return {
        kind: "derived",
        reason: origin.reason,
        ...(origin.from ? { from: renderOrigin(origin.from) } : {}),
      };
  }
}

function renderSourceRef(ref: { path: string; span: WireSpan }): WireSourceRef {
  return { kind: "source", path: ref.path, span: [ref.span.start, ref.span.end] };
}

function renderRegion(region: SourceMapRegion): WireRegion {
  return {
    target: region.target,
    origin: renderOrigin(region.origin),
    ...(region.construct ? { construct: region.construct } : {}),
  };
}

/** Collect every unique source path referenced (directly, or via a macro
 *  call) across all recorded regions, sorted. */
function collectSources(recorder: SourceMapRecorder): string[] {
  const paths = new Set<string>();
  const visit = (origin: OriginRef): void => {
    switch (origin.kind) {
      case "source":
        paths.add(origin.path);
        return;
      case "macro":
        paths.add(origin.call.path);
        if (origin.inner) visit(origin.inner);
        return;
      case "derived":
        if (origin.from) visit(origin.from);
    }
  };
  for (const regions of recorder.entries().values()) {
    for (const r of regions) visit(r.origin);
  }
  return [...paths].sort();
}

/** Render the `.loom/sourcemap.json` artifact from a fully-populated
 *  `SourceMapRecorder`.  Stable ordering: file keys sorted, regions kept
 *  in recording (insertion) order within each file. */
export function renderSourceMap(recorder: SourceMapRecorder): string {
  const sources = collectSources(recorder);
  const files: Record<string, WireRegion[]> = {};
  for (const path of [...recorder.entries().keys()].sort()) {
    const regions = recorder.entries().get(path) ?? [];
    files[path] = regions.map(renderRegion);
  }
  return `${JSON.stringify({ version: 1, sources, files }, null, 2)}\n`;
}
