// Per-page unfold code action (M-T1.5 slice A): when the cursor sits on a
// `with scaffold(...)` clause, alongside the whole-macro unfold the provider
// offers one "Unfold page 'Area / Name'" refactor per produced page.  Applying
// one ejects that single page (wrapped in its `area`) as `.ddd` source while
// leaving the macro — and thus its sibling pages — in place; scope-local
// override-by-name suppresses exactly the ejected page.

import { NodeFileSystem } from "langium/node";
import { validationHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import type { CodeAction, Position, TextEdit } from "vscode-languageserver";
import { createDddServices } from "../../src/language/ddd-module.js";

const services = createDddServices(NodeFileSystem);
const validate = validationHelper(services.Ddd);

function positionOf(source: string, marker: string): Position {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker "${marker}" not found`);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

function offsetOf(text: string, pos: Position): number {
  let offset = 0;
  let line = 0;
  for (let i = 0; i < text.length && line < pos.line; i++) {
    if (text[i] === "\n") line++;
    offset = i + 1;
  }
  return offset + pos.character;
}

function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });
  let out = text;
  for (const e of sorted) {
    const start = offsetOf(text, e.range.start);
    const end = offsetOf(text, e.range.end);
    out = out.slice(0, start) + e.newText + out.slice(end);
    text = out;
  }
  return out;
}

const SOURCE = `
system Demo {
  context Sales {
    aggregate Order {
      subject: string
    }
    repository Orders for Order { }
  }
  ui Admin with scaffold(aggregates: [Order]) { }
}
`;

async function actionsAt(source: string, marker: string): Promise<CodeAction[]> {
  const result = await validate(source);
  const document = result.document;
  const pos = positionOf(source, marker);
  return (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri: document.textDocument.uri },
    range: { start: pos, end: pos },
    context: { diagnostics: [] },
  })) as CodeAction[];
}

async function applyAction(source: string, marker: string, title: string): Promise<string> {
  const result = await validate(source);
  const document = result.document;
  const pos = positionOf(source, marker);
  const actions = (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri: document.textDocument.uri },
    range: { start: pos, end: pos },
    context: { diagnostics: [] },
  })) as CodeAction[];
  const action = actions.find((a) => a.title === title);
  if (!action) {
    throw new Error(`no action "${title}"; got: ${actions.map((a) => a.title).join(", ")}`);
  }
  const edits = action.edit?.changes?.[document.textDocument.uri] ?? [];
  return applyEdits(source, edits);
}

describe("per-page unfold code action", () => {
  it("offers one per-page unfold per scaffolded page, alongside the whole-macro unfold", async () => {
    const titles = (await actionsAt(SOURCE, "scaffold")).map((a) => a.title);
    // Whole-macro unfold still offered.
    expect(titles).toContain("Unfold macro 'scaffold'");
    // Per-page unfolds for the aggregate's three pages, area-qualified.
    expect(titles).toContain("Unfold page 'Orders / List'");
    expect(titles).toContain("Unfold page 'Orders / New'");
    expect(titles).toContain("Unfold page 'Orders / Detail'");
  });

  it("ejects a single page wrapped in its area, keeping the macro (siblings scaffolded)", async () => {
    const unfolded = await applyAction(SOURCE, "scaffold", "Unfold page 'Orders / Detail'");
    // The macro clause is NOT removed — siblings stay under scaffold.
    expect(unfolded).toMatch(/with scaffold\(aggregates: \[Order\]\)/);
    // The ejected page lands inside a real `area Orders { … }` with a body.
    expect(unfolded).toMatch(/area Orders/);
    expect(unfolded).toMatch(/page Detail/);
    // Only Detail was ejected — List/New are not written as explicit source.
    expect(unfolded).not.toMatch(/page List/);
    expect(unfolded).not.toMatch(/page New/);
  });

  it("re-parses to a working program (override-by-name suppresses the scaffold copy)", async () => {
    const unfolded = await applyAction(SOURCE, "scaffold", "Unfold page 'Orders / Detail'");
    const reparse = await validate(unfolded);
    const errors = reparse.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
  });

  it("ejects a loose singleton page (Home) without an area wrapper", async () => {
    const unfolded = await applyAction(SOURCE, "scaffold", "Unfold page 'Home'");
    expect(unfolded).toMatch(/with scaffold\(aggregates: \[Order\]\)/);
    expect(unfolded).toMatch(/page Home/);
    // Home is a ui-scope singleton — not wrapped in an aggregate area.
    expect(unfolded).not.toMatch(/area Orders\s*\{\s*page Home/);
    const reparse = await validate(unfolded);
    expect(reparse.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});
