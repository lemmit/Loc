import { describe, expect, it } from "vitest";
import type { SourceMapRegion } from "../../src/generator/_trace/sourcemap.js";
import { renderSourceMapV3 } from "../../src/system/sourcemap-v3.js";

// ---------------------------------------------------------------------------
// Unit coverage for renderSourceMapV3's multi-source path — a project built
// from an import graph resolves origins into more than one `.ddd` file, so
// `sources` must dedup + sort and the segments' `sourceIndex` deltas must
// switch files correctly.  The end-to-end sidecar test in sourcemap.test.ts
// only ever sees a single-source fixture; this pins the cross-file case at
// the unit level (decoder copied from there — see its doc comments).
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVLQField(str: string, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  let more: boolean;
  do {
    const digit = B64.indexOf(str[pos.i++]!);
    expect(digit, `invalid base64-VLQ char in "${str}" at ${pos.i - 1}`).toBeGreaterThanOrEqual(0);
    more = (digit & 0x20) !== 0;
    result += (digit & 0x1f) << shift;
    shift += 5;
  } while (more);
  return result & 1 ? -(result >> 1) : result >> 1;
}

interface DecodedSegment {
  genLine: number; // 0-based
  genCol: number; // 0-based
  sourceIndex: number;
  sourceLine: number;
  sourceCol: number;
}

function decodeMappings(mappings: string): DecodedSegment[] {
  const segments: DecodedSegment[] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceCol = 0;
  const lines = mappings.split(";");
  for (let li = 0; li < lines.length; li++) {
    let genCol = 0;
    const line = lines[li]!;
    if (line === "") continue;
    for (const seg of line.split(",")) {
      const pos = { i: 0 };
      const fields: number[] = [];
      while (pos.i < seg.length) fields.push(decodeVLQField(seg, pos));
      expect(fields.length).toBe(4);
      genCol += fields[0]!;
      sourceIndex += fields[1]!;
      sourceLine += fields[2]!;
      sourceCol += fields[3]!;
      segments.push({ genLine: li, genCol, sourceIndex, sourceLine, sourceCol });
    }
  }
  return segments;
}

// Line 3 (0-based 2), col 4 of B; line 1 (0-based 0), col 0 of A.  Offsets
// are byte positions into these exact strings.
const TEXT_A = "context One {\n}\n";
const TEXT_B = "// header\n\n    aggregate Two {\n    }\n";

const region = (
  target: [number, number],
  path: string,
  start: number,
  end: number,
): SourceMapRegion => ({
  target,
  origin: { kind: "source", path, span: { start, end } },
});

describe("renderSourceMapV3 (unit)", () => {
  it("maps regions from two source files with correct sourceIndex switching", () => {
    const sourceTexts = new Map([
      ["/b/two.ddd", TEXT_B],
      ["/a/one.ddd", TEXT_A],
    ]);
    const regions: SourceMapRegion[] = [
      // Generated lines 1-2 come from A's `context One` (offset 0 = line 0, col 0);
      // lines 3-4 from B's `aggregate Two` (offset 15 = line 2, col 4).
      region([1, 2], "/a/one.ddd", 0, 13),
      region([3, 4], "/b/two.ddd", TEXT_B.indexOf("aggregate"), TEXT_B.indexOf("aggregate") + 9),
    ];
    const rendered = renderSourceMapV3(regions, "out/gen.ts", sourceTexts);
    expect(rendered).toBeDefined();
    const v3 = JSON.parse(rendered!) as {
      file: string;
      sources: string[];
      sourcesContent: string[];
      mappings: string;
    };

    expect(v3.file).toBe("gen.ts");
    // Deduped + sorted, sourcesContent index-aligned.
    expect(v3.sources).toEqual(["/a/one.ddd", "/b/two.ddd"]);
    expect(v3.sourcesContent).toEqual([TEXT_A, TEXT_B]);

    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(4);
    const bySourceIdx = segments.map((s) => s.sourceIndex);
    expect(bySourceIdx).toEqual([0, 0, 1, 1]);
    // A's region start: line 0 col 0; B's: line 2 col 4.
    expect(segments[0]).toMatchObject({ genLine: 0, sourceLine: 0, sourceCol: 0 });
    expect(segments[2]).toMatchObject({ genLine: 2, sourceLine: 2, sourceCol: 4 });
    expect(segments[3]).toMatchObject({ genLine: 3, sourceLine: 2, sourceCol: 4 });
  });

  it("drops regions whose source text is missing, keeping the rest", () => {
    const sourceTexts = new Map([["/a/one.ddd", TEXT_A]]);
    const regions: SourceMapRegion[] = [
      region([1, 1], "/a/one.ddd", 0, 13),
      region([2, 2], "/missing.ddd", 0, 5),
    ];
    const rendered = renderSourceMapV3(regions, "gen.ts", sourceTexts);
    expect(rendered).toBeDefined();
    const v3 = JSON.parse(rendered!) as { sources: string[]; mappings: string };
    expect(v3.sources).toEqual(["/a/one.ddd"]);
    // Line 2's only region was dropped — its mapping group must be empty.
    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.genLine).toBe(0);
  });

  it("returns undefined when nothing resolves", () => {
    const regions: SourceMapRegion[] = [region([1, 1], "/missing.ddd", 0, 5)];
    expect(renderSourceMapV3(regions, "gen.ts", new Map())).toBeUndefined();
  });
});

// Span-tracking emission (span-tracking-emission.md, M15 phase 7 slice 2):
// `targetCol`-bearing regions supersede the col-0 construct-granular
// fallback on the lines they cover, and multiple such regions on ONE
// generated line become multiple segments, sorted by column.
describe("renderSourceMapV3 — targetCol (unit)", () => {
  it("reports the real generated column instead of col 0 when targetCol is present", () => {
    const sourceTexts = new Map([["/a/one.ddd", TEXT_A]]);
    const regions: SourceMapRegion[] = [
      { ...region([1, 1], "/a/one.ddd", 0, 7), targetCol: [10, 17] },
    ];
    const rendered = renderSourceMapV3(regions, "gen.ts", sourceTexts);
    const v3 = JSON.parse(rendered!) as { mappings: string };
    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(1);
    // 1-based targetCol[0] = 10 -> 0-based genCol = 9.
    expect(segments[0]).toMatchObject({ genLine: 0, genCol: 9 });
  });

  it("emits multiple segments, sorted by column, when several regions share one generated line", () => {
    const sourceTexts = new Map([["/a/one.ddd", TEXT_A]]);
    const regions: SourceMapRegion[] = [
      // Deliberately built out of column order — the renderer must sort.
      { ...region([1, 1], "/a/one.ddd", 8, 13), targetCol: [20, 25] },
      { ...region([1, 1], "/a/one.ddd", 0, 7), targetCol: [3, 8] },
    ];
    const rendered = renderSourceMapV3(regions, "gen.ts", sourceTexts);
    const v3 = JSON.parse(rendered!) as { mappings: string };
    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.genLine === 0)).toBe(true);
    // Ascending genCol, 0-based (targetCol[0] - 1).
    expect(segments[0]!.genCol).toBe(2);
    expect(segments[1]!.genCol).toBe(19);
    // Each segment's source position matches its OWN region's span, not
    // whichever happened to sort first.
    expect(segments[0]!.sourceCol).toBe(0); // from the [0,7) region's offset 0
    expect(segments[1]!.sourceCol).toBe(8); // from the [8,13) region's offset 8
  });

  it("keeps the col-0 fallback on a line with no targetCol-bearing region", () => {
    const sourceTexts = new Map([["/a/one.ddd", TEXT_A]]);
    const regions: SourceMapRegion[] = [region([1, 1], "/a/one.ddd", 0, 7)];
    const rendered = renderSourceMapV3(regions, "gen.ts", sourceTexts);
    const v3 = JSON.parse(rendered!) as { mappings: string };
    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.genCol).toBe(0);
  });

  it("emits ONLY the column segments on a line covered by both a targetCol and a plain region", () => {
    const sourceTexts = new Map([["/a/one.ddd", TEXT_A]]);
    const regions: SourceMapRegion[] = [
      // Coarse statement-level region and a fine expression-level one on the
      // SAME generated line — the fine one supersedes (its real column IS the
      // more precise fact; emitting both would put a bogus col-0 segment
      // ahead of it).
      region([1, 1], "/a/one.ddd", 0, 13),
      { ...region([1, 1], "/a/one.ddd", 0, 7), targetCol: [10, 17] },
    ];
    const rendered = renderSourceMapV3(regions, "gen.ts", sourceTexts);
    const v3 = JSON.parse(rendered!) as { mappings: string };
    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ genLine: 0, genCol: 9 });
  });

  // The running source deltas (sourceIndex / sourceLine / sourceCol) are
  // SHARED between the targetCol path and the col-0 fallback path — a delta
  // bug at the seam corrupts every segment AFTER the first marked line while
  // all single-path tests stay green.  Pin a map that crosses the seam twice:
  // plain line → marked line → plain line, across two source files.
  it("keeps source deltas continuous across mixed targetCol and col-0 lines", () => {
    const sourceTexts = new Map([
      ["/a/one.ddd", TEXT_A],
      ["/b/two.ddd", TEXT_B],
    ]);
    const aggOffset = TEXT_B.indexOf("aggregate"); // line 2 (0-based), col 4
    const regions: SourceMapRegion[] = [
      region([1, 1], "/a/one.ddd", 0, 7), // plain, A offset 0 -> (0,0)
      { ...region([2, 2], "/b/two.ddd", aggOffset, aggOffset + 9), targetCol: [12, 21] },
      region([3, 3], "/a/one.ddd", TEXT_A.indexOf("}"), TEXT_A.indexOf("}") + 1), // plain, A (1,0)
    ];
    const rendered = renderSourceMapV3(regions, "gen.ts", sourceTexts);
    const v3 = JSON.parse(rendered!) as { sources: string[]; mappings: string };
    const segments = decodeMappings(v3.mappings);
    expect(segments).toHaveLength(3);

    const idxA = v3.sources.indexOf("/a/one.ddd");
    const idxB = v3.sources.indexOf("/b/two.ddd");
    // The decoder accumulates raw deltas, so these ABSOLUTE positions only
    // come out right if both emission paths advance the shared state.
    expect(segments[0]).toMatchObject({
      genLine: 0,
      genCol: 0,
      sourceIndex: idxA,
      sourceLine: 0,
      sourceCol: 0,
    });
    expect(segments[1]).toMatchObject({
      genLine: 1,
      genCol: 11,
      sourceIndex: idxB,
      sourceLine: 2,
      sourceCol: 4,
    });
    expect(segments[2]).toMatchObject({
      genLine: 2,
      genCol: 0,
      sourceIndex: idxA,
      sourceLine: 1,
      sourceCol: 0,
    });
  });
});
