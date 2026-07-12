// The scaffold-once regeneration-preservation marker
// (docs/proposals/extern-domain-extension-point.md, Slice 1).

import { describe, expect, it } from "vitest";
import { isScaffoldOnce, SCAFFOLD_ONCE_MARKER } from "../../src/util/scaffold-once.js";

describe("isScaffoldOnce", () => {
  it("detects the marker on the first line (any comment syntax)", () => {
    expect(isScaffoldOnce(`# ${SCAFFOLD_ONCE_MARKER} — yours\ndefmodule X do\nend\n`)).toBe(true);
    expect(isScaffoldOnce(`// ${SCAFFOLD_ONCE_MARKER}\nclass X {}\n`)).toBe(true);
    // Single-line file with no newline.
    expect(isScaffoldOnce(`# ${SCAFFOLD_ONCE_MARKER}`)).toBe(true);
  });

  it("is false for ordinary generated files", () => {
    expect(isScaffoldOnce("defmodule X do\nend\n")).toBe(false);
    expect(isScaffoldOnce("")).toBe(false);
  });

  it("only scans the first line — a later occurrence is not a false positive", () => {
    // The token buried in a string literal deeper in the file must not count.
    const content = `defmodule X do\n  @doc "see ${SCAFFOLD_ONCE_MARKER} docs"\nend\n`;
    expect(isScaffoldOnce(content)).toBe(false);
  });
});
