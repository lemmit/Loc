import { describe, expect, it } from "vitest";
import { applyTextEdits, offsetAt, selectionFor } from "../../web/src/editor/apply-edits.js";
import { inDocumentOrder, stepIndex, toEditorRange } from "../../web/src/layout/problem-nav.js";
import type { Diagnostic } from "../../web/src/lsp/protocol.js";

// The Problems panel's two pure halves (M-T8.18): the text-edit application
// the mobile textarea uses for **Fix** (Monaco has its own model), and the
// F8 walk order + wrap-around.

const diag = (line: number, character: number, message = "m"): Diagnostic => ({
  range: { start: { line, character }, end: { line, character: character + 3 } },
  severity: "error",
  message,
});

describe("applyTextEdits", () => {
  const text = "aggregate Order {\n  total: money\n  qty: int\n}\n";

  it("resolves 1-based line/column offsets, clamping past the end", () => {
    expect(offsetAt(text, 1, 1)).toBe(0);
    expect(offsetAt(text, 2, 3)).toBe(text.indexOf("total"));
    expect(offsetAt(text, 2, 999)).toBe(text.indexOf("\n", text.indexOf("total")));
    expect(offsetAt(text, 99, 1)).toBe(text.length);
  });

  it("replaces one span (the `unknown-name` did-you-mean shape)", () => {
    const out = applyTextEdits(text, [
      {
        range: { startLineNumber: 3, startColumn: 8, endLineNumber: 3, endColumn: 11 },
        text: "integer",
      },
    ]);
    expect(out).toBe("aggregate Order {\n  total: money\n  qty: integer\n}\n");
  });

  it("applies a batch last-to-first so earlier offsets stay valid", () => {
    const out = applyTextEdits(text, [
      {
        range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 8 },
        text: "amount",
      },
      {
        range: { startLineNumber: 3, startColumn: 3, endLineNumber: 3, endColumn: 6 },
        text: "quantity",
      },
    ]);
    expect(out).toBe("aggregate Order {\n  amount: money\n  quantity: int\n}\n");
  });

  it("selectionFor never yields end < start", () => {
    expect(
      selectionFor(text, { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 }),
    ).toEqual({ start: 20, end: 20 });
  });
});

describe("problem navigation", () => {
  it("walks problems in document order", () => {
    const ordered = inDocumentOrder([diag(5, 2, "c"), diag(1, 9, "b"), diag(1, 1, "a")]);
    expect(ordered.map((d) => d.message)).toEqual(["a", "b", "c"]);
  });

  it("steps with wrap-around from no cursor, and reports -1 on an empty list", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });

  it("shifts LSP ranges to the editor's 1-based ones, widening a point to one column", () => {
    expect(toEditorRange(diag(3, 4))).toEqual({
      startLineNumber: 4,
      startColumn: 5,
      endLineNumber: 4,
      endColumn: 8,
    });
    const point: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: "error",
      message: "m",
    };
    expect(toEditorRange(point)).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    });
  });
});
