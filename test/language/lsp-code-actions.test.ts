import { NodeFileSystem } from "langium/node";
import { validationHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import type { CodeAction, TextEdit } from "vscode-languageserver";
import { createDddServices } from "../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Code-action (quick-fix) tests.  Parse + validate, feed the resulting
// diagnostics to the provider, then apply the returned edit and compare the
// rewritten source.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const validate = validationHelper(services.Ddd);

async function fix(text: string, title: string): Promise<string> {
  const result = await validate(text);
  const document = result.document;
  const actions = (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri: document.textDocument.uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: result.diagnostics },
  })) as CodeAction[];
  const action = actions.find((a) => a.title === title);
  if (!action)
    throw new Error(
      `no code action titled "${title}"; got: ${actions.map((a) => a.title).join(", ")}`,
    );
  const edits = action.edit?.changes?.[document.textDocument.uri] ?? [];
  return applyEdits(text, edits, document.textDocument.offsetAt.bind(document.textDocument));
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

describe("CodeActionProvider", () => {
  it.skip("placeholder — no code actions registered after display-on-Property removal", () => {
    // The `Change type to 'string'` quick-fix went away with the `display`
    // property annotation.  Display is now a `derived display: string = ...`
    // clause on the aggregate; the validator doesn't surface a code-action
    // for it (the message is enough).
  });
});

void fix; // keep the helper around for future code-action tests
