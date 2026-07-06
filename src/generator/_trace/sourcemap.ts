// ---------------------------------------------------------------------------
// SourceMapRecorder — the generate-time recorder each backend orchestrator's
// per-construct emit loop optionally reports into.  Records a whole-file
// [startLine, endLine] region against the `OriginRef` chain the IR node
// carried in from lowering (see src/ir/types/origin.ts).
//
// Construct-granular by default (Milestone 1 — see
// docs/plans/source-map-debug-kickoff.md §2): `file()` records one region
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
}

/** One `fragment()` sub-region per statement, keyed to the chunk list a
 *  backend's chunk-producing statement renderer built from the SAME
 *  statements array (same length, same order — one chunk per statement,
 *  chunks joined with `"\n"` to form the fragment).  `rel` is a 1-based
 *  inclusive line range relative to the fragment's own first line; a
 *  statement with no `origin` (synthesized) is simply omitted.
 *  Origin-generic on purpose: `StmtIR` and `WorkflowStmtIR` both satisfy
 *  the element shape, so every backend shares this one cursor walk. */
export function statementSubRegions(
  stmts: readonly { origin?: OriginRef }[],
  chunks: readonly string[],
  construct: string,
): SourceMapSubRegion[] {
  const regions: SourceMapSubRegion[] = [];
  let cursor = 1;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const chunkLines = (chunk.match(/\n/g)?.length ?? 0) + 1;
    const origin = stmts[i]?.origin;
    if (origin) regions.push({ rel: [cursor, cursor + chunkLines - 1], origin, construct });
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
 *  docs/plans/source-map-and-debugging.md). */
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
