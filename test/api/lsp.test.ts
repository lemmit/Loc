import { describe, expect, it } from "vitest";
import {
  applyPatches,
  fixHintCodeActions,
  toLspDiagnostics,
  validate,
} from "../../src/api/index.js";

// ---------------------------------------------------------------------------
// LSP / editor adapters (src/api/lsp.ts) — the thin boundary that makes the
// toolkit's ModelPatch / JsonDiagnostic recognizable to Monaco & VS Code.
// ---------------------------------------------------------------------------

const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

/** Apply LSP TextEdits to a source (line/char → offset, end-to-start). */
function applyTextEdits(
  source: string,
  edits: {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    newText: string;
  }[],
): string {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: { line: number; character: number }) => lineStarts[p.line]! + p.character;
  let text = source;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
    text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  }
  return text;
}

describe("LSP adapters", () => {
  it("toLspDiagnostics maps a coded diagnostic to an LSP Diagnostic", async () => {
    const report = await validate(BARE);
    const diags = toLspDiagnostics(report);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    const bare = diags.find((d) => d.code === "loom.bare-aggregate-in-type");
    expect(bare?.severity).toBe(1); // DiagnosticSeverity.Error
    expect(bare?.source).toBe("loom");
    expect(bare?.range).toBeDefined();
  });

  it("fixHintCodeActions yields a quick-fix whose WorkspaceEdit fixes the model", async () => {
    const report = await validate(BARE);
    const actions = await fixHintCodeActions(report, BARE, "file:///m.ddd");

    const fix = actions.find((a) => a.kind === "quickfix");
    expect(fix).toBeDefined();
    expect(fix?.diagnostics?.[0]?.code).toBe("loom.bare-aggregate-in-type");

    const edits = fix?.edit?.changes?.["file:///m.ddd"];
    expect(edits?.length).toBe(1);
    expect(edits?.[0]?.newText).toBe("customer: Customer id");

    // Applying the editor edit yields a model that re-validates clean.
    const fixed = applyTextEdits(BARE, edits ?? []);
    const after = await validate(fixed);
    expect(after.ok).toBe(true);

    // …and it matches what the patch applier produces from the same patch.
    const viaPatch = await applyPatches(BARE, [report.diagnostics[0]!.fixHint!.patch!]);
    expect(fixed).toBe(viaPatch.text);
  });
});
