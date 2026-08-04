import { describe, expect, it } from "vitest";
import { buildDiagnosticsToLsp } from "../../web/src/lsp/build-diagnostics.js";

// Mobile has no language client (M-T8.15), so its Problems panel is fed from
// `generate`.  This is the projection that makes that possible; the thing it
// must not get wrong is the coordinate base — a 1-based line rendered as if it
// were 0-based points the user at the wrong statement, which is worse than
// showing nothing.
describe("buildDiagnosticsToLsp", () => {
  it("converts 1-based build positions to 0-based LSP positions", () => {
    const [d] = buildDiagnosticsToLsp([
      { severity: "error", message: "boom", line: 12, column: 5 },
    ]);
    expect(d.range.start).toEqual({ line: 11, character: 4 });
    expect(d.range.end).toEqual({ line: 11, character: 4 });
  });

  it("puts a position-less diagnostic on the first line", () => {
    const [d] = buildDiagnosticsToLsp([{ severity: "error", message: "whole-file" }]);
    expect(d.range.start).toEqual({ line: 0, character: 0 });
  });

  it("never emits a negative position for an already-0-based producer", () => {
    const [d] = buildDiagnosticsToLsp([
      { severity: "warning", message: "edge", line: 0, column: 0 },
    ]);
    expect(d.range.start).toEqual({ line: 0, character: 0 });
  });

  it("carries severity and defaults the source to loom", () => {
    const out = buildDiagnosticsToLsp([
      { severity: "warning", message: "w" },
      { severity: "error", message: "e", source: "custom" },
    ]);
    expect(out.map((d) => d.severity)).toEqual(["warning", "error"]);
    expect(out.map((d) => d.source)).toEqual(["loom", "custom"]);
  });

  it("is empty for no input", () => {
    expect(buildDiagnosticsToLsp([])).toEqual([]);
  });
});
