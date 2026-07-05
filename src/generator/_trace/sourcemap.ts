// ---------------------------------------------------------------------------
// SourceMapRecorder — the generate-time recorder each backend orchestrator's
// per-construct emit loop optionally reports into.  Records a whole-file
// [startLine, endLine] region against the `OriginRef` chain the IR node
// carried in from lowering (see src/ir/types/origin.ts).
//
// Construct-granular only (Milestone 1 — see
// docs/plans/source-map-debug-kickoff.md §2): one region per emitted file,
// not per statement/line.  Pooled/merged files (domain/ids.ts,
// db/schema.ts, ...) are simply never `.file(...)`-recorded — they stay
// unmapped rather than getting a misleading single-origin region.
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

/** Number of 1-based lines `content` spans.  A trailing `"\n"` doesn't
 *  count as an extra (empty) final line. */
function lineCount(content: string): number {
  const parts = content.split("\n");
  const n = content.endsWith("\n") ? parts.length - 1 : parts.length;
  return Math.max(1, n);
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
    const key = this.prefix ? `${this.prefix}/${path}` : path;
    const region: SourceMapRegion = { target: [1, lineCount(content)], origin, construct };
    const existing = this.store.get(key);
    if (existing) existing.push(region);
    else this.store.set(key, [region]);
  }

  entries(): ReadonlyMap<string, readonly SourceMapRegion[]> {
    return this.store;
  }
}
