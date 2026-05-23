import { NodeFileSystem } from "langium/node";
import { parseDocument } from "langium/test";
import { describe, expect, it } from "vitest";
import type { TextEdit } from "vscode-languageserver";
import { createDddServices } from "../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Rename tests.  No `expectRename` helper exists in langium/test, so we drive
// the provider directly: `<|>` marks the cursor, we strip it, rename, then
// apply the returned edits and compare the rewritten source.  Covers a
// cross-reference rename (default path) and a member rename (fallback path).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;

async function renameAt(text: string, newName: string): Promise<string> {
  const cursor = text.indexOf("<|>");
  if (cursor < 0) throw new Error("no <|> cursor marker");
  const clean = text.replace("<|>", "");
  const doc = await parseDocument(services, clean);
  const position = doc.textDocument.positionAt(cursor);
  const edit = await services.lsp.RenameProvider!.rename(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position,
    newName,
  });
  const edits = edit?.changes?.[doc.textDocument.uri] ?? [];
  return applyEdits(clean, edits, doc.textDocument.offsetAt.bind(doc.textDocument));
}

function applyEdits(
  text: string,
  edits: TextEdit[],
  offsetAt: (p: { line: number; character: number }) => number,
): string {
  const resolved = edits
    .map((e) => ({ start: offsetAt(e.range.start), end: offsetAt(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

describe("RenameProvider — cross references", () => {
  it("renames an aggregate and its X id usages", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate <|>Order {
    customerId: string
  }
  aggregate Customer {
    primaryOrder: Order id
  }
}`,
      "Sale",
    );
    expect(result).toContain("aggregate Sale {");
    expect(result).toContain("Sale id");
    expect(result).not.toContain("aggregate Order");
    expect(result).not.toContain("Order id");
  });
});

describe("RenameProvider — member access", () => {
  it("renames a property and its `this.` usage", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate Order {
    customerId: string
    function ownerId(): string = this.<|>customerId
  }
}`,
      "ownerKey",
    );
    expect(result).toContain("ownerKey: string");
    expect(result).toContain("this.ownerKey");
    expect(result).not.toContain("customerId");
  });

  it("renames a property from its declaration", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate Order {
    <|>customerId: string
    function ownerId(): string = this.customerId
  }
}`,
      "ownerKey",
    );
    expect(result).toContain("ownerKey: string");
    expect(result).toContain("this.ownerKey");
    expect(result).not.toContain("customerId");
  });

  it("renames a property used as an assignment target", async () => {
    const result = await renameAt(
      `context Sales {
  enum Status { Open, Closed }
  aggregate Order {
    <|>status: Status
    operation close() { status := Closed }
  }
}`,
      "state",
    );
    expect(result).toContain("state: Status");
    expect(result).toContain("state := Closed");
    expect(result).not.toMatch(/\bstatus\b/);
  });
});
