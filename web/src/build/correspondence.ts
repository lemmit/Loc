// Source ↔ output correspondence — the pure core behind the playground's
// Compiler-Explorer-style mapping (M-T8.20 slice 3).
//
// TWO DIRECTIONS, ONE MAP.  `.loom/sourcemap.json` records, per generated
// file, a list of regions: a generated line range, the `OriginRef` chain it
// came from, and the dotted construct id (`Sales.Order.addLine`).  That one
// artifact answers both questions the UI asks:
//
//   forward  — "I am hovering line N of `main.ddd`; which generated files did
//              it produce, and which lines in them?"  → `correspondenceAt`
//   backward — "I am hovering line M of `api/domain/order.ts`; which `.ddd`
//              span produced it?"                     → `sourceSpanFor`
//
// and one more for the godbolt colour toggle:
//
//   bands    — "colour every declaration and every generated region it owns
//              with the same hue" → `sourceBands` / `generatedBands`.
//
// Everything here is PURE (no React, no DOM, no `monaco`) so
// `test/playground/correspondence.test.ts` can drive it against a real
// sourcemap produced by a real generate, across several backends and a
// frontend, without a browser.
//
// The wire types and the two path/origin primitives are imported from
// `src/trace/` — the same published-JSON consumer `ddd trace` uses — rather
// than re-declared, so the playground can never drift from the artifact's
// contract.  `src/dap/breakpoints.ts` walks the same forward direction for
// `ddd breakpoints`; this module deliberately does NOT reuse it, because that
// one collapses each match to a single armable `file:line` (a breakpoint has
// no height) whereas a highlight needs the whole range.

import { resolveToSource } from "../../../src/ir/types/origin.js";
import type { SourceRef } from "../../../src/ir/types/origin.js";
import {
  isSamePath,
  LineIndex,
  type SourceMap,
  toOriginRef,
  type WireRegion,
} from "../../../src/trace/index.js";

/** One highlighted range inside a generated file. */
export interface GeneratedSpan {
  /** 1-based inclusive generated line range. */
  startLine: number;
  endLine: number;
  /** 1-based half-open generated columns — only ever present on the fine
   *  expression-level regions the TS/Hono backend records (`targetCol`). */
  startColumn?: number;
  endColumn?: number;
  /** Dotted construct id the region carries, when it has one. */
  construct?: string;
  /** Width of the ORIGIN span, in `.ddd` characters — the tie-break that
   *  decides which construct is "the" one under the cursor. */
  originWidth: number;
  /** 1-based `.ddd` line the origin span BEGINS on.  When it equals the
   *  hovered line, the cursor is on the region's own declaration head
   *  rather than somewhere inside it — the distinction `anchored` spans
   *  are selected by. */
  originStartLine: number;
}

/** Every generated file one `.ddd` position produced. */
export interface CorrespondenceFile {
  file: string;
  /** All matching regions, narrowest origin first. */
  spans: GeneratedSpan[];
  /** The subset a viewer should decorate — see `pickHighlights`. */
  highlights: GeneratedSpan[];
}

export interface Correspondence {
  /** The `.ddd` file + 1-based line the lookup was made at. */
  path: string;
  line: number;
  /** The narrowest construct covering the position — what the UI names.
   *  Absent when the matching regions carry no construct id. */
  construct?: string;
  /** Matching generated files, sorted by path. */
  files: CorrespondenceFile[];
}

/** What one generated line points back to in the `.ddd`. */
export interface SourceSpan {
  /** `.ddd` path as the map records it (`/workspace/main.ddd`). */
  path: string;
  /** Character offsets, as recorded. */
  span: [number, number];
  /** 1-based inclusive line range, present only when the caller supplied
   *  the `.ddd` text to index. */
  startLine?: number;
  endLine?: number;
  construct?: string;
}

/** One coloured band — a line range plus the construct whose colour it takes. */
export interface Band {
  construct: string;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Forward: `.ddd` position → generated files / ranges
// ---------------------------------------------------------------------------

/**
 * Every generated file (and the ranges within it) that the `.ddd` line
 * `line` of `path` produced.
 *
 * Matching is by ORIGIN OVERLAP, the same rule `src/dap/breakpoints.ts`
 * uses: resolve each region's origin chain down to a real `SourceRef`
 * (a bare `derived` ref with no `from` is skipped — it has no source to
 * point at), keep it when the ref's file matches and its character span
 * overlaps the requested line's own `[start, end)` byte range.
 *
 * Overlap — not containment — is what makes a MACRO-produced region
 * appear: `aggregate Product with crudish` records its synthesised
 * `update` operation against the `crudish` token on that very line, so
 * hovering the declaration lights up the macro's output too. That is the
 * feature, not a false positive.
 *
 * Returns `null` when nothing matches, so a caller can distinguish "no
 * correspondence here" from "an empty result".
 */
export function correspondenceAt(
  map: SourceMap,
  path: string,
  line: number,
  sourceText: string,
): Correspondence | null {
  const index = new LineIndex(sourceText);
  const lineStart = index.offsetOfLine(line);
  const lineEnd = index.offsetOfLine(line + 1);
  if (lineEnd <= lineStart) return null;

  const byFile = new Map<string, GeneratedSpan[]>();
  const anchored: GeneratedSpan[] = [];

  for (const [file, regions] of Object.entries(map.files ?? {})) {
    for (const region of regions) {
      const source = sourceOf(region);
      if (!source) continue;
      if (!isSamePath(source.path, path)) continue;
      if (!overlaps(source.span.start, source.span.end, lineStart, lineEnd)) continue;
      const span = toSpan(region, source, index);
      let list = byFile.get(file);
      if (!list) {
        list = [];
        byFile.set(file, list);
      }
      list.push(span);
      if (span.originStartLine === line) anchored.push(span);
    }
  }
  if (byFile.size === 0) return null;

  const files: CorrespondenceFile[] = [];
  for (const [file, spans] of byFile) {
    spans.sort(byOriginThenPosition);
    files.push({ file, spans, highlights: pickHighlights(spans, line) });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { path, line, ...labelOf(anchored, byFile), files };
}

/** The construct the hover NAMES.
 *
 *  When something is anchored on this line — the cursor sits on a
 *  declaration head — the WIDEST such construct wins: `aggregate Product
 *  with crudish` anchors both `Products.Product` (the whole declaration)
 *  and `Products.Product.update` (the `crudish` token, which is on that
 *  same line), and the aggregate is what the user pointed at.  With
 *  nothing anchored, the cursor is inside a body and the NARROWEST
 *  covering construct is the honest answer. */
function labelOf(
  anchored: readonly GeneratedSpan[],
  byFile: ReadonlyMap<string, GeneratedSpan[]>,
): { construct?: string } {
  const named = anchored.filter((s) => s.construct);
  if (named.length > 0) {
    let best = named[0]!;
    for (const s of named) if (s.originWidth > best.originWidth) best = s;
    return { construct: best.construct };
  }
  let best: GeneratedSpan | undefined;
  for (const spans of byFile.values()) {
    for (const s of spans) {
      if (!s.construct) continue;
      if (!best || s.originWidth < best.originWidth) best = s;
    }
  }
  return best?.construct ? { construct: best.construct } : {};
}

/** The subset of one file's matching spans a viewer should decorate.
 *
 *  Every mapped file carries ONE whole-file region (`target: [1, N]`) for
 *  the declaration that produced it, plus — on the backends that record
 *  them — narrow per-statement / per-expression regions. Which of the two
 *  the user means depends on where the cursor is, and the sourcemap already
 *  says: a region whose ORIGIN BEGINS on the hovered line is a declaration
 *  the cursor is pointing AT, while one that merely covers the line is a
 *  declaration the cursor is INSIDE.
 *
 *    - on `aggregate Product with crudish` → the aggregate's own region is
 *      anchored, so the whole generated file lights up (and so do the two
 *      lines `crudish` synthesised, which are anchored there too);
 *    - on `operation addLine(…)` deep inside `aggregate Order` → only
 *      addLine's regions are anchored, so the operation's own lines light
 *      up instead of all 126 lines of `order.ts`.
 *
 *  With nothing anchored (a plain field line inside a declaration), fall
 *  back to the narrowest covering spans — for most files that is the
 *  whole-file region, which is the honest answer for a backend that records
 *  nothing finer. */
export function pickHighlights(spans: readonly GeneratedSpan[], line: number): GeneratedSpan[] {
  const anchored = spans.filter((s) => s.originStartLine === line);
  if (anchored.length > 0) return anchored;
  return narrowestSpans(spans);
}

/** Drop a span when another matching span in the same file sits strictly
 *  inside it. */
export function narrowestSpans(spans: readonly GeneratedSpan[]): GeneratedSpan[] {
  const kept = spans.filter(
    (s) => !spans.some((other) => other !== s && strictlyInside(other, s)),
  );
  return kept.length > 0 ? kept : [...spans];
}

// ---------------------------------------------------------------------------
// Backward: generated position → `.ddd` span
// ---------------------------------------------------------------------------

/**
 * The `.ddd` span that produced line `line` (optionally column `column`) of
 * generated `file`.
 *
 * Region choice mirrors `resolveFrame` (`src/trace/resolve.ts`) so the
 * playground's hover and `ddd trace`'s stack annotation never disagree:
 * with a column, prefer the narrowest `targetCol`-bearing region containing
 * it; otherwise take the narrowest LINE range, excluding every
 * `targetCol`-bearing region so a fine expression region can't win a
 * line-width contest on no column evidence.
 *
 * `sourceText`, when given, upgrades the raw character offsets to a 1-based
 * line range — what a Monaco decoration needs.
 */
export function sourceSpanFor(
  map: SourceMap,
  file: string,
  line: number,
  column?: number,
  sourceText?: string,
): SourceSpan | null {
  const regions = regionsFor(map, file);
  if (!regions) return null;
  const covering = regions.filter((r) => line >= r.target[0] && line <= r.target[1]);

  let picked: WireRegion | undefined;
  if (column !== undefined) {
    let width = Number.POSITIVE_INFINITY;
    for (const r of covering) {
      if (!r.targetCol) continue;
      if (column < r.targetCol[0] || column >= r.targetCol[1]) continue;
      const w = r.targetCol[1] - r.targetCol[0];
      if (!picked || w < width) {
        picked = r;
        width = w;
      }
    }
  }
  if (!picked) {
    for (const r of covering) {
      if (r.targetCol) continue;
      if (!picked || r.target[1] - r.target[0] < picked.target[1] - picked.target[0]) picked = r;
    }
  }
  if (!picked) return null;

  const source = sourceOf(picked);
  if (!source) return null;
  const out: SourceSpan = {
    path: source.path,
    span: [source.span.start, source.span.end],
    ...(picked.construct ? { construct: picked.construct } : {}),
  };
  if (sourceText !== undefined) {
    const index = new LineIndex(sourceText);
    out.startLine = index.lineOf(source.span.start);
    // `end` is exclusive; an origin that ends exactly on a line boundary
    // would otherwise claim the following (blank) line.
    out.endLine = index.lineOf(Math.max(source.span.start, source.span.end - 1));
  }
  return out;
}

/** The map key for `file`, matched by longest path suffix.  The playground's
 *  generated paths and the map's keys are both project-relative, so this is
 *  normally an exact hit; the suffix match is what keeps a `/workspace/
 *  generated/`-prefixed path (the workspace merge writes them there) resolving
 *  too. */
function regionsFor(map: SourceMap, file: string): WireRegion[] | undefined {
  const files = map.files ?? {};
  const exact = files[file];
  if (exact) return exact;
  let best: WireRegion[] | undefined;
  let bestLen = 0;
  let tied = false;
  for (const [key, regions] of Object.entries(files)) {
    if (!isSamePath(key, file)) continue;
    const len = key.length;
    if (len > bestLen) {
      best = regions;
      bestLen = len;
      tied = false;
    } else if (len === bestLen) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

// ---------------------------------------------------------------------------
// Colour mapping (the godbolt toggle)
// ---------------------------------------------------------------------------

/** Eight hues, evenly spaced, chosen for the dark editor theme: enough to
 *  tell neighbouring declarations apart, few enough that two constructs
 *  sharing a hue is obviously a collision rather than a claim. */
const BAND_HUES = [200, 25, 145, 320, 55, 265, 175, 0];

/** How many distinct band colours exist — the CSS side generates one class
 *  per band, so it needs the count without importing the table. */
export const BAND_HUE_COUNT = BAND_HUES.length;

/** The hue of band `index`. */
export function hueOfBand(index: number): number {
  return BAND_HUES[index % BAND_HUES.length]!;
}

/** A stable band index for a construct id — the same declaration takes the
 *  same colour in the source editor and in every generated file it produced,
 *  which is the entire point of the mapping.  Deterministic (a content hash,
 *  not an enumeration order) so it survives a regenerate that reorders
 *  files. */
export function constructBand(construct: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < construct.length; i++) {
    h ^= construct.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % BAND_HUES.length;
}

/** The hue a construct takes — `hueOfBand(constructBand(...))`. */
export function constructHue(construct: string): number {
  return hueOfBand(constructBand(construct));
}

/** `hsl()` fill for a construct's band, at the given alpha. */
export function constructColor(construct: string, alpha = 0.18): string {
  return `hsla(${constructHue(construct)}, 70%, 55%, ${alpha})`;
}

/** Every declaration band in the `.ddd` source: one line range per construct,
 *  widened to cover all the regions that construct owns.  Drives the source
 *  editor's colour overlay. */
export function sourceBands(map: SourceMap, path: string, sourceText: string): Band[] {
  const index = new LineIndex(sourceText);
  const byConstruct = new Map<string, Band>();
  for (const regions of Object.values(map.files ?? {})) {
    for (const region of regions) {
      if (!region.construct) continue;
      const source = sourceOf(region);
      if (!source || !isSamePath(source.path, path)) continue;
      const startLine = index.lineOf(source.span.start);
      const endLine = index.lineOf(Math.max(source.span.start, source.span.end - 1));
      const existing = byConstruct.get(region.construct);
      if (!existing) {
        byConstruct.set(region.construct, { construct: region.construct, startLine, endLine });
      } else {
        existing.startLine = Math.min(existing.startLine, startLine);
        existing.endLine = Math.max(existing.endLine, endLine);
      }
    }
  }
  return [...byConstruct.values()].sort((a, b) => a.startLine - b.startLine);
}

/** Every coloured band inside one generated file — the other half of the
 *  mapping.  Narrow regions are kept as-is; the whole-file region is kept
 *  too (a file with no finer regions still deserves its declaration's hue). */
export function generatedBands(map: SourceMap, file: string): Band[] {
  const regions = regionsFor(map, file) ?? [];
  const out: Band[] = [];
  for (const region of regions) {
    if (!region.construct) continue;
    out.push({
      construct: region.construct,
      startLine: region.target[0],
      endLine: region.target[1],
    });
  }
  // Narrow bands last so a viewer painting in order lets them win over the
  // whole-file band they sit inside.
  return out.sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine));
}

/** Every generated file the map has regions for — what the Explorer marks as
 *  "mapped" when the colour toggle is on. */
export function mappedFiles(map: SourceMap): string[] {
  return Object.keys(map.files ?? {}).sort();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sourceOf(region: WireRegion): SourceRef | undefined {
  return resolveToSource(toOriginRef(region.origin));
}

function toSpan(region: WireRegion, source: SourceRef, index: LineIndex): GeneratedSpan {
  return {
    startLine: region.target[0],
    endLine: region.target[1],
    ...(region.targetCol
      ? { startColumn: region.targetCol[0], endColumn: region.targetCol[1] }
      : {}),
    ...(region.construct ? { construct: region.construct } : {}),
    originWidth: source.span.end - source.span.start,
    originStartLine: index.lineOf(source.span.start),
  };
}

/** Standard half-open interval overlap. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Is `inner` strictly narrower than `outer` while sitting inside it? */
function strictlyInside(inner: GeneratedSpan, outer: GeneratedSpan): boolean {
  if (inner.startLine < outer.startLine || inner.endLine > outer.endLine) return false;
  return inner.endLine - inner.startLine < outer.endLine - outer.startLine;
}

function byOriginThenPosition(a: GeneratedSpan, b: GeneratedSpan): number {
  if (a.originWidth !== b.originWidth) return a.originWidth - b.originWidth;
  return a.startLine - b.startLine;
}
