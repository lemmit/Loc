import type { SourceMapRegion } from "../generator/_trace/sourcemap.js";
import { offsetToLineCol } from "../generator/_trace/sourcemap.js";
import { resolveToSource } from "../ir/types/origin.js";

// ---------------------------------------------------------------------------
// Source Map v3 sidecars — Milestone 5 of docs/proposals/source-map-and-
// debugging.md.  Sibling of sourcemap.ts (the construct-granular
// `.loom/sourcemap.json` artifact): renders the SAME recorded regions into
// the standard `<file>.map` shape a debugger / browser devtools already
// understands, instead of Loom's bespoke wire format.
//
// Scope (pinned, see the M5 brief): node/Hono `.ts`/`.tsx` output only — the
// only backend whose per-statement regions land on files a JS/TS debugger
// steps through.  Other backends record regions too, but there is no v3
// consumer for `.cs`/`.java`/`.py`/`.ex` today.
//
// Line/col derivation happens off the shared `offsetToLineCol` (D-ORIGIN-
// OFFSETS) in `src/generator/_trace/sourcemap.ts` — `OriginRef` spans stay
// byte offsets everywhere else; that helper is the one conversion boundary
// every (line, col) consumer shares.  It returns 1-based pairs; v3 mappings
// are 0-based, so this file subtracts 1 at its own call site rather than
// pushing a 0-based variant onto the shared helper's other consumer (the
// .NET `#line` weave, which wants 1-based directly).  Dependency-free:
// `source-map` / `convert-source-map` are only transitive dev deps, not
// importable from `src/` — the base64-VLQ encoder below is hand-rolled
// (standard algorithm, ~20 lines).
// ---------------------------------------------------------------------------

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode one signed integer as base64-VLQ (the Source Map v3 field
 *  encoding): the sign is folded into bit 0, then the magnitude is emitted
 *  5 bits at a time, low-order chunk first, with bit 5 of each base64
 *  digit set on every chunk but the last (the "more digits follow" flag). */
function encodeVLQ(value: number): string {
  let vlq = value < 0 ? (-value << 1) + 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    out += BASE64_CHARS[digit];
  } while (vlq > 0);
  return out;
}

/** A recorded region that survived the `sourceTexts` filter, with its
 *  origin already resolved to a real source span and converted to
 *  0-based (line, col). */
interface ResolvedRegion {
  target: [number, number];
  path: string;
  line: number;
  col: number;
}

/** Narrowest region covering generated line `line` — same tie-break rule as
 *  `resolveFrame` in src/trace/resolve.ts (smallest target range wins;
 *  ties keep the earlier region), replicated here rather than imported: the
 *  brief pins `src/system/` to stay independent of `src/trace/`. */
function narrowestRegion(
  regions: readonly ResolvedRegion[],
  line: number,
): ResolvedRegion | undefined {
  let best: ResolvedRegion | undefined;
  for (const r of regions) {
    if (line < r.target[0] || line > r.target[1]) continue;
    if (!best || r.target[1] - r.target[0] < best.target[1] - best.target[0]) best = r;
  }
  return best;
}

/** Render one Source Map v3 sidecar from a single generated file's recorded
 *  regions.  Returns `undefined` when nothing survives the `sourceTexts`
 *  filter — an honest skip (no sidecar) rather than a map with no useful
 *  content.
 *
 *  One segment per generated line that has a covering region, at column 0,
 *  pointing at the (line, col) of that region's resolved origin span
 *  START.  Lines with no covering region get no segment (an empty mapping
 *  group) — this is a construct-granular map, not a statement-by-statement
 *  column map. */
export function renderSourceMapV3(
  regions: readonly SourceMapRegion[],
  generatedFileName: string,
  sourceTexts: ReadonlyMap<string, string>,
): string | undefined {
  const resolved: ResolvedRegion[] = [];
  for (const region of regions) {
    const source = resolveToSource(region.origin);
    if (!source) continue;
    const text = sourceTexts.get(source.path);
    if (text === undefined) continue;
    // Shared helper is 1-based; v3 mappings are 0-based.
    const { line, col } = offsetToLineCol(text, source.span.start);
    resolved.push({ target: region.target, path: source.path, line: line - 1, col: col - 1 });
  }
  if (resolved.length === 0) return undefined;

  const sources = [...new Set(resolved.map((r) => r.path))].sort();
  const sourceIndexOf = new Map(sources.map((p, i) => [p, i] as const));
  const sourcesContent = sources.map((p) => sourceTexts.get(p)!);

  const maxLine = Math.max(...resolved.map((r) => r.target[1]));
  let prevSourceIndex = 0;
  let prevSourceLine = 0;
  let prevSourceCol = 0;
  const lineGroups: string[] = [];
  for (let line = 1; line <= maxLine; line++) {
    const region = narrowestRegion(resolved, line);
    if (!region) {
      lineGroups.push("");
      continue;
    }
    const sourceIndex = sourceIndexOf.get(region.path)!;
    // Fields, in order: generated column (always 0 — the sole segment on
    // the line, so its delta from the line's implicit reset-to-0 start is
    // 0), source index / line / column — each a delta from the PREVIOUS
    // segment's value across the whole file (not reset per line), per the
    // v3 spec.
    const segment =
      encodeVLQ(0) +
      encodeVLQ(sourceIndex - prevSourceIndex) +
      encodeVLQ(region.line - prevSourceLine) +
      encodeVLQ(region.col - prevSourceCol);
    prevSourceIndex = sourceIndex;
    prevSourceLine = region.line;
    prevSourceCol = region.col;
    lineGroups.push(segment);
  }

  const file = generatedFileName.split("/").pop() ?? generatedFileName;
  return `${JSON.stringify({
    version: 3,
    file,
    sources,
    sourcesContent,
    names: [],
    mappings: lineGroups.join(";"),
  })}\n`;
}
