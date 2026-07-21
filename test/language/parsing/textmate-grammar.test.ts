import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Guards the hand-maintained TextMate grammar: it must exist, parse, declare
// the right scope, and cover the top-level constructs.  Catches the grammar
// drifting out of sync with new language keywords.
// ---------------------------------------------------------------------------

const grammarPath = fileURLToPath(
  new URL("../../../vscode/grammars/ddd.tmLanguage.json", import.meta.url),
);

const CORE_KEYWORDS = [
  "system",
  "module",
  "context",
  "aggregate",
  "entity",
  "valueobject",
  "enum",
  "event",
  "repository",
  "workflow",
  "deployable",
  "ui",
  "api",
  "storage",
  "operation",
  "function",
];

describe("TextMate grammar", () => {
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));

  it("declares the ddd scope", () => {
    expect(grammar.scopeName).toBe("source.ddd");
    expect(grammar.fileTypes).toContain(".ddd");
  });

  it("covers every top-level declaration keyword", () => {
    const declMatch = grammar.repository?.["declaration-keywords"]?.match as string;
    expect(declMatch).toBeTruthy();
    for (const kw of CORE_KEYWORDS) {
      expect(declMatch).toMatch(new RegExp(`\\b${kw}\\b`));
    }
  });

  it("colours primitive types separately from keywords", () => {
    const prims = grammar.repository?.["primitive-types"]?.match as string;
    for (const p of ["int", "long", "decimal", "string", "bool", "datetime", "guid"]) {
      expect(prims).toMatch(new RegExp(`\\b${p}\\b`));
    }
  });
});
