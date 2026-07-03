// C12 (full-review-remediation §C): the "exactly one system" composition count
// must be scoped to the current document's IMPORT CLOSURE, not every loaded
// document.  Two UNRELATED single-system projects opened in the same LSP
// workspace previously counted each other's `system`, so each spuriously
// reported "the project declares 2 'system' blocks".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

const TWO_SYSTEMS = /declares \d+ 'system/;

// A complete single-system project with a top-level (composition-requiring)
// `theme` member — its presence is what makes the composition check run.
const project = (name: string) => `
  system ${name} {
    subdomain M${name} { context C${name} { aggregate A { x: int } } }
  }
  theme { primary: "#112233" }
`;

describe("C12 — composition count is scoped to the import closure", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-c12-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function harness() {
    const shared = createDddServices(NodeFileSystem).shared;
    const uri = (rel: string): URI => URI.file(path.join(dir, rel));
    const open = async (rel: string, text: string): Promise<void> => {
      fs.writeFileSync(path.join(dir, rel), text);
      const doc = shared.workspace.LangiumDocumentFactory.fromString(text, uri(rel));
      shared.workspace.LangiumDocuments.addDocument(doc);
      await shared.workspace.DocumentBuilder.update([uri(rel)], []);
    };
    const errorsFor = (rel: string, match: RegExp): string[] =>
      (shared.workspace.LangiumDocuments.getDocument(uri(rel))?.diagnostics ?? [])
        .filter((d) => (d.severity ?? 4) === 1 && match.test(d.message))
        .map((d) => d.message);
    return { open, errorsFor };
  }

  it("two unlinked single-system documents don't count each other's system", async () => {
    const h = await harness();
    await h.open("a.ddd", project("SA"));
    await h.open("b.ddd", project("SB"));
    expect(h.errorsFor("a.ddd", TWO_SYSTEMS), "a.ddd").toEqual([]);
    expect(h.errorsFor("b.ddd", TWO_SYSTEMS), "b.ddd").toEqual([]);
  });
});
