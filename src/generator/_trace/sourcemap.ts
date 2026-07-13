// ---------------------------------------------------------------------------
// SourceMapRecorder — the generate-time recorder each backend orchestrator's
// per-construct emit loop optionally reports into.  Records a whole-file
// [startLine, endLine] region against the `OriginRef` chain the IR node
// carried in from lowering (see src/ir/types/origin.ts).
//
// Construct-granular by default (Milestone 1 — see
// docs/old/plans/source-map-debug-kickoff.md §2): `file()` records one region
// per emitted file, not per statement/line.  Pooled/merged files
// (domain/ids.ts, db/schema.ts, ...) are simply never `.file(...)`-recorded
// — they stay unmapped rather than getting a misleading single-origin
// region.  `fragment()` (Milestone 3, source-map-and-debugging.md §5.2)
// layers statement-granular sub-regions onto one already-`file()`-recorded
// fragment (e.g. one operation body) by anchoring its exact text in the
// file's final content — line-anchored, not offset-tracked, so it needs no
// cooperation from the string-builder that assembled the file.
//
// Pure and side-effect-free besides its own internal Map — safe to import
// from browser-bundled code (the web playground), like the rest of
// src/generator/.
// ---------------------------------------------------------------------------

import type { OriginRef } from "../../ir/types/origin.js";

export interface SourceMapRegion {
  /** 1-based inclusive [startLine, endLine] in the generated file. */
  target: [number, number];
  origin: OriginRef;
  /** Dotted construct id, e.g. "Sales.Order" or "Sales.Order.confirm". */
  construct?: string;
  /** OPTIONAL real generated column range — 1-based, half-open
   *  `[startCol, endCol)` (mirrors `offsetToLineCol`'s existing 1-based col
   *  convention: `startCol` is the column of the first marked character,
   *  `endCol` the column one past the last).  Converted to 0-based only at
   *  the Source Map v3 boundary (`src/system/sourcemap-v3.ts`), the same
   *  treatment `target`'s line numbers already get.  Only meaningful when
   *  `target[0] === target[1]` (a single-line region) — present only for
   *  expression-level marks produced by a backend's marks-carrying
   *  statement renderer (span-tracking-emission.md, M15 phase 7 slice 2,
   *  TS/Hono only this slice).  Absent everywhere else, which keeps the
   *  pre-existing col-0 v3 fallback untouched. */
  targetCol?: [number, number];
}

/** One statement-granular sub-region within a `fragment()` call — a line
 *  range RELATIVE to the start of the fragment text (1-based, inclusive),
 *  paired with the origin of the statement it covers.  `origin: undefined`
 *  (a synthesized statement with no `.ddd` span) is skipped, same as a
 *  `file()` call with no origin. */
export interface SourceMapSubRegion {
  rel: [number, number];
  origin: OriginRef | undefined;
  construct?: string;
  /** OPTIONAL real generated column range within the sub-region's own
   *  single `rel` line — 1-based, half-open `[startCol, endCol)`, straight
   *  passthrough into `SourceMapRegion.targetCol` (see there for the
   *  convention).  Only ever set by `statementSubRegions`'s `exprMarks`
   *  parameter below; a plain per-statement sub-region carries none. */
  col?: [number, number];
}

/** One expression-level mark inside a SINGLE already-rendered statement
 *  chunk (span-tracking-emission.md, M15 phase 7 slice 2) — `start`/`end`
 *  are 0-based, end-exclusive character offsets into that OWNING chunk
 *  string (not the whole fragment), paired with the origin the marked
 *  sub-expression resolved to.  Produced by a backend's marks-carrying
 *  statement helper (e.g. `statementExprMarks` in
 *  `src/generator/typescript/render-stmt.ts`) by locating a
 *  `renderExprWithMarks` result's text inside the chunk via the same
 *  one-occurrence anchor discipline `fragment()` uses below. */
export interface ChunkMark {
  start: number;
  end: number;
  origin: OriginRef;
}

/** One `fragment()` sub-region per statement, keyed to the chunk list a
 *  backend's chunk-producing statement renderer built from the SAME
 *  statements array (same length, same order — one chunk per statement,
 *  chunks joined with `"\n"` to form the fragment).  `rel` is a 1-based
 *  inclusive line range relative to the fragment's own first line; a
 *  statement with no `origin` (synthesized) is simply omitted.
 *  Origin-generic on purpose: `StmtIR` and `WorkflowStmtIR` both satisfy
 *  the element shape, so every backend shares this one cursor walk.
 *
 *  `exprMarks`, when passed, layers FINER column-level sub-regions onto the
 *  same cursor walk: `exprMarks[i]` is the `ChunkMark[]` for `chunks[i]`
 *  (span-tracking-emission.md, M15 phase 7 slice 2 — TS/Hono only this
 *  slice, so every other caller simply omits the parameter and gets
 *  byte-identical behavior).  Each mark's chunk-relative offset is turned
 *  into a (line, col) via the shared `offsetToLineCol`; a mark whose start
 *  and end fall on DIFFERENT lines is skipped (this slice only marks
 *  single-line `let`/`assign`/`return` RHS expressions, so that shouldn't
 *  occur in practice, but a multi-line mark has no single `col` to report
 *  and an honest skip beats a wrong one). */
export function statementSubRegions(
  stmts: readonly { origin?: OriginRef }[],
  chunks: readonly string[],
  construct: string,
  exprMarks?: readonly (readonly ChunkMark[])[],
): SourceMapSubRegion[] {
  const regions: SourceMapSubRegion[] = [];
  let cursor = 1;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const chunkLines = (chunk.match(/\n/g)?.length ?? 0) + 1;
    const origin = stmts[i]?.origin;
    if (origin) regions.push({ rel: [cursor, cursor + chunkLines - 1], origin, construct });
    for (const mark of exprMarks?.[i] ?? []) {
      const startPos = offsetToLineCol(chunk, mark.start);
      const endPos = offsetToLineCol(chunk, mark.end);
      if (startPos.line !== endPos.line) continue;
      const absLine = cursor + startPos.line - 1;
      regions.push({
        rel: [absLine, absLine],
        origin: mark.origin,
        construct,
        col: [startPos.col, endPos.col],
      });
    }
    cursor += chunkLines;
  }
  return regions;
}

/** Number of 1-based lines `content` spans.  A trailing `"\n"` doesn't
 *  count as an extra (empty) final line.  Exported for the callers that
 *  build a single-subregion `fragment()` call per statement (rather than
 *  the cursor-walked `statementSubRegions` — the elixir workflow/reactor
 *  bodies, whose bucketing REORDERS statements relative to source order, so
 *  the single-fragment relative-cursor shape doesn't apply; see M13,
 *  docs/old/plans/source-map-and-debugging.md). */
export function lineCount(content: string): number {
  const parts = content.split("\n");
  const n = content.endsWith("\n") ? parts.length - 1 : parts.length;
  return Math.max(1, n);
}

/** 1-based line number of `content[idx]` — the line `idx` (a match start)
 *  falls on, counting every `"\n"` strictly before it. */
function lineAt(content: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (content[i] === "\n") n++;
  return n;
}

/** 1-based (line, col) of `offset` within `text` — this is the
 *  origin-tooling shared home for byte-offset → (line, col) conversion
 *  (`OriginRef` spans stay byte offsets everywhere else; this is the
 *  conversion boundary).  Consumed by `src/system/sourcemap-v3.ts` (which
 *  converts to the 0-based pairs the Source Map v3 spec uses at its own
 *  call site) and by the .NET enhanced `#line` directive weave
 *  (`src/generator/dotnet/emit/entity.ts`), which wants 1-based pairs
 *  directly — C#'s `#line (line,col)-(line,col)` form is 1-based. */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

export class SourceMapRecorder {
  private readonly store: Map<string, SourceMapRegion[]>;
  private readonly prefix: string;

  private constructor(store: Map<string, SourceMapRegion[]>, prefix: string) {
    this.store = store;
    this.prefix = prefix;
  }

  static create(): SourceMapRecorder {
    return new SourceMapRecorder(new Map(), "");
  }

  /** View that prefixes every recorded path with `${prefix}/`.  Shares the
   *  underlying store, so regions recorded through a scoped view are
   *  visible via `entries()` on the recorder it was scoped from. */
  scope(prefix: string): SourceMapRecorder {
    const nested = this.prefix ? `${this.prefix}/${prefix}` : prefix;
    return new SourceMapRecorder(this.store, nested);
  }

  /** Record a whole-file region `[1, lineCount(content)]`.  No-op when
   *  `origin` is undefined — derived/synthesized IR nodes (auto-findAll,
   *  etc.) carry no origin and are silently skipped, never faked. */
  file(path: string, content: string, origin: OriginRef | undefined, construct?: string): void {
    if (!origin) return;
    this.push(path, { target: [1, lineCount(content)], origin, construct });
  }

  /** Record statement-granular sub-regions inside a single already-emitted
   *  fragment (e.g. one operation body) of an emitted file.  Anchors
   *  `fragmentText` in `content` by exact-text search rather than tracking
   *  offsets through the renderer:
   *
   *  - absent, or present more than once, in `content` → record NOTHING
   *    (an honest skip — a non-unique anchor would be a guess, not a fact);
   *  - otherwise, the fragment's absolute start line is `content`'s line at
   *    the match index, and each `subRegions` entry with a defined `origin`
   *    is pushed as a `[abs + rel[0] - 1, abs + rel[1] - 1]` region (`rel`
   *    is 1-based and relative to the fragment's own first line).
   *
   *  A sub-region with `origin: undefined` (a synthesized statement) is
   *  skipped silently, same as `file()`. */
  fragment(
    path: string,
    content: string,
    fragmentText: string,
    subRegions: readonly SourceMapSubRegion[],
  ): void {
    const firstIdx = content.indexOf(fragmentText);
    if (firstIdx === -1) return;
    if (content.indexOf(fragmentText, firstIdx + 1) !== -1) return;
    const abs = lineAt(content, firstIdx);
    for (const sub of subRegions) {
      if (!sub.origin) continue;
      this.push(path, {
        target: [abs + sub.rel[0] - 1, abs + sub.rel[1] - 1],
        origin: sub.origin,
        construct: sub.construct,
        ...(sub.col ? { targetCol: sub.col } : {}),
      });
    }
  }

  private push(path: string, region: SourceMapRegion): void {
    const key = this.prefix ? `${this.prefix}/${path}` : path;
    const existing = this.store.get(key);
    if (existing) existing.push(region);
    else this.store.set(key, [region]);
  }

  entries(): ReadonlyMap<string, readonly SourceMapRegion[]> {
    return this.store;
  }
}
