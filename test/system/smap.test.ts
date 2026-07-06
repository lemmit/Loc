import { describe, expect, it } from "vitest";
import type { SourceMapRegion } from "../../src/generator/_trace/sourcemap.js";
import { renderSmap } from "../../src/system/smap.js";

// ---------------------------------------------------------------------------
// Unit coverage for `renderSmap` — the JSR-45 SMAP sibling of
// `sourcemap-v3.ts` (M10 phase 6b).  Mirrors `sourcemap-v3.test.ts`'s
// structure and fixtures (whole-file + statement sub-region shape,
// two-source-file case, missing-text drop, all-dropped => undefined), but
// asserts the exact SMAP TEXT rather than decoding a v3 mappings string.
// ---------------------------------------------------------------------------

const region = (
  target: [number, number],
  path: string,
  start: number,
  end: number,
): SourceMapRegion => ({
  target,
  origin: { kind: "source", path, span: { start, end } },
});

describe("renderSmap (unit)", () => {
  it("renders a whole-file region plus statement sub-regions as one *L entry per generated line", () => {
    // "let note = customerName" starts at offset 17 on .ddd line 18 (the
    // brief's own worked example); a whole-file region covers generated
    // lines 1-26, and two statement sub-regions NARROW lines 25-26 down to
    // their own (more specific) origins.
    const sourceText = `${"\n".repeat(17)}  let note = customerName\n  emit OrderPlaced { order: id }\n`;
    const letOffset = sourceText.indexOf("let note");
    const emitOffset = sourceText.indexOf("emit OrderPlaced");
    const sourceTexts = new Map([["/abs/path/main.ddd", sourceText]]);

    const regions: SourceMapRegion[] = [
      region([1, 26], "/abs/path/main.ddd", 0, sourceText.length),
      region([25, 25], "/abs/path/main.ddd", letOffset, letOffset + 8),
      region([26, 26], "/abs/path/main.ddd", emitOffset, emitOffset + 16),
    ];

    const rendered = renderSmap(regions, "src/main/java/features/orders/Order.java", sourceTexts);
    expect(rendered).toBeDefined();
    const lines = rendered!.split("\n");

    expect(lines[0]).toBe("SMAP");
    expect(lines[1]).toBe("Order.java");
    expect(lines[2]).toBe("Loom");
    expect(lines[3]).toBe("*S Loom");
    expect(lines[4]).toBe("*F");
    expect(lines[5]).toBe("+ 1 main.ddd");
    expect(lines[6]).toBe("/abs/path/main.ddd");
    expect(lines[7]).toBe("*L");
    // Line 1 of the file is covered only by the whole-file region (input
    // line 1); lines 25 and 26 are covered by the NARROWER statement
    // sub-regions, pointing at the .ddd lines the statements actually sit
    // on (18 and 19 respectively — 17 leading blank lines + 1).
    const lIndex = lines.indexOf("*L");
    const eIndex = lines.indexOf("*E");
    const lEntries = lines.slice(lIndex + 1, eIndex);
    expect(lEntries[0]).toBe("1#1:1");
    expect(lEntries.at(-2)).toBe("18#1:25");
    expect(lEntries.at(-1)).toBe("19#1:26");
    expect(lines[lines.length - 1]).toBe(""); // trailing newline
    expect(rendered!.endsWith("*E\n")).toBe(true);
  });

  it("maps regions from two source files with correct file IDs, deduped + sorted", () => {
    const textA = "context One {\n}\n";
    const textB = "// header\n\n    aggregate Two {\n    }\n";
    const sourceTexts = new Map([
      ["/b/two.ddd", textB],
      ["/a/one.ddd", textA],
    ]);
    const regions: SourceMapRegion[] = [
      region([1, 2], "/a/one.ddd", 0, 13),
      region([3, 4], "/b/two.ddd", textB.indexOf("aggregate"), textB.indexOf("aggregate") + 9),
    ];

    const rendered = renderSmap(regions, "out/Gen.java", sourceTexts);
    expect(rendered).toBeDefined();
    const expected = [
      "SMAP",
      "Gen.java",
      "Loom",
      "*S Loom",
      "*F",
      "+ 1 one.ddd",
      "/a/one.ddd",
      "+ 2 two.ddd",
      "/b/two.ddd",
      "*L",
      "1#1:1",
      "1#1:2",
      "3#2:3",
      "3#2:4",
      "*E",
      "",
    ].join("\n");
    expect(rendered).toBe(expected);
  });

  it("drops regions whose source text is missing, keeping the rest", () => {
    const textA = "context One {\n}\n";
    const sourceTexts = new Map([["/a/one.ddd", textA]]);
    const regions: SourceMapRegion[] = [
      region([1, 1], "/a/one.ddd", 0, 13),
      region([2, 2], "/missing.ddd", 0, 5),
    ];

    const rendered = renderSmap(regions, "Gen.java", sourceTexts);
    expect(rendered).toBeDefined();
    const expected = [
      "SMAP",
      "Gen.java",
      "Loom",
      "*S Loom",
      "*F",
      "+ 1 one.ddd",
      "/a/one.ddd",
      "*L",
      "1#1:1",
      "*E",
      "",
    ].join("\n");
    expect(rendered).toBe(expected);
  });

  it("returns undefined when nothing resolves (all dropped)", () => {
    const regions: SourceMapRegion[] = [region([1, 1], "/missing.ddd", 0, 5)];
    expect(renderSmap(regions, "Gen.java", new Map())).toBeUndefined();
  });
});
