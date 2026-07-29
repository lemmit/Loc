// Layout contract for what `unfold` writes back into a user's file.
//
// The other unfold suites assert the *structure* of the ejected source (which
// pages, which `with` clause, does it re-parse).  This one asserts it reads
// like hand-written `.ddd`: no trailing whitespace, blank-line-separated
// declarations, and no line past the 100-column budget once the insertion
// indent is accounted for (2026-07 unfold review, defects 5-7 —
// `docs/audits/unfold-printer-layout-review-2026-07.md`).

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
  const sorted = [...edits].sort((a, b) =>
    a.range.start.line !== b.range.start.line
      ? b.range.start.line - a.range.start.line
      : b.range.start.character - a.range.start.character,
  );
  let out = text;
  for (const e of sorted) {
    const start = offsetOf(text, e.range.start);
    const end = offsetOf(text, e.range.end);
    out = out.slice(0, start) + e.newText + out.slice(end);
    text = out;
  }
  return out;
}

// An EMPTY `ui` body (`{ }`) — the inline-brace insert path, which used to
// leave the `{`'s space stranded as trailing whitespace.
const SOURCE = `system Demo {
  context Sales {
    aggregate Order {
      subject: string
      total: money
      status: OrderStatus
      operation ship(carrier: string) { }
      create(subject: string) { }
    }
    enum OrderStatus { draft, shipped }
    repository Orders for Order { }
    workflow Fulfil {
      create start(orderId: Order id) { }
    }
  }
  ui Admin with scaffold(aggregates: [Order], workflows: [Fulfil]) { }
}
`;

async function allUnfolds(source: string, marker: string): Promise<Map<string, string>> {
  const result = await validate(source);
  const document = result.document;
  const pos = positionOf(source, marker);
  const actions = (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri: document.textDocument.uri },
    range: { start: pos, end: pos },
    context: { diagnostics: [] },
  })) as CodeAction[];
  const out = new Map<string, string>();
  for (const a of actions) {
    const edits = a.edit?.changes?.[document.textDocument.uri] ?? [];
    out.set(a.title, applyEdits(source, edits));
  }
  return out;
}

describe("unfold output layout", () => {
  it("leaves no trailing whitespace on any line", async () => {
    for (const [title, text] of await allUnfolds(SOURCE, "scaffold(")) {
      const offenders = text
        .split("\n")
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => /[ \t]+$/.test(l))
        .map(([n, l]) => `${title} line ${n}: ${JSON.stringify(l)}`);
      expect(offenders).toEqual([]);
    }
  });

  it("blank-line-separates the ejected declarations", async () => {
    const text = (await allUnfolds(SOURCE, "scaffold(")).get("Unfold macro 'scaffold'")!;
    // Two loose singleton pages are ejected side by side; they must not run
    // together into one wall.
    expect(text).toMatch(/\n\n\s*page WorkflowsIndex \{/);
  });

  it("does not open the block with a blank line", async () => {
    const text = (await allUnfolds(SOURCE, "scaffold(")).get("Unfold macro 'scaffold'")!;
    expect(text).not.toMatch(/\{\n\n\s*page Home/);
  });

  it("keeps every line inside the 100-column budget", async () => {
    for (const [title, text] of await allUnfolds(SOURCE, "scaffold(")) {
      const offenders = text
        .split("\n")
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => l.length > 100)
        .map(([n, l]) => `${title} line ${n} (${l.length} cols): ${l.trim().slice(0, 60)}…`);
      expect(offenders).toEqual([]);
    }
  });

  it("re-parses cleanly for every offered unfold", async () => {
    for (const [title, text] of await allUnfolds(SOURCE, "scaffold(")) {
      const reparse = await validate(text);
      const errors = reparse.diagnostics.filter((d) => d.severity === 1);
      expect(errors.map((e) => `${title}: ${e.message}`)).toEqual([]);
    }
  });
});
