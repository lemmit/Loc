// Regression: a macro ref-list argument (`with scaffold(subdomains: [Sales])`)
// names a `subdomain` declared in a *sibling* file.  Those refs are resolved
// by name during the pre-link expansion pass — they are NOT Langium
// cross-references — so the default affected-doc computation never
// re-validates the macro-host document when the sibling file later loads.
//
// Before the fix that left a stale "references unknown Subdomain" error on the
// scaffold line of multi-file projects (e.g. the Acme ERP example, whose
// `deploy.ddd` scaffolds subdomains declared in sales.ddd / inventory.ddd /
// …) whenever the host was indexed before its siblings.
//
// The fix: the expander stays silent about unresolved refs (they may just not
// have loaded yet) and the validator re-resolves them against the settled
// workspace on every (re)validation, while an `isAffected` override re-runs
// that validation when the workspace document set changes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";

const UNKNOWN_SUBDOMAIN = /references unknown Subdomain/;

describe("cross-file scaffold ref-list resolution", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-xfile-scaffold-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function harness() {
    const shared = createDddServices(NodeFileSystem).shared;
    const uri = (rel: string): URI => URI.file(path.join(dir, rel));
    const open = async (rel: string, text: string): Promise<void> => {
      fs.writeFileSync(path.join(dir, rel), text);
      const doc = shared.workspace.LangiumDocumentFactory.fromString(text, uri(rel));
      shared.workspace.LangiumDocuments.addDocument(doc);
      await shared.workspace.DocumentBuilder.update([uri(rel)], []);
    };
    const macroErrors = (rel: string): string[] =>
      (shared.workspace.LangiumDocuments.getDocument(uri(rel))?.diagnostics ?? [])
        .filter((d) => (d.severity ?? 4) <= 2 && UNKNOWN_SUBDOMAIN.test(d.message))
        .map((d) => d.message);
    return { open, macroErrors };
  }

  const SALES = `subdomain Sales {
    context Orders { aggregate Order { name: string } repository Orders for Order {} }
  }`;

  it("clears the scaffold error once the sibling subdomain file is indexed", async () => {
    const { open, macroErrors } = harness();
    // Host opens FIRST — its only link to Sales is the (untracked) macro arg.
    await open(
      "main.ddd",
      `import "./sales.ddd"\nsystem S { }\nui Web with scaffold(subdomains: [Sales]) { }\n`,
    );
    expect(macroErrors("main.ddd")).toHaveLength(1);

    // The sibling lands later: the host must re-validate and clear.
    await open("sales.ddd", SALES);
    expect(macroErrors("main.ddd")).toEqual([]);
  });

  it("keeps erroring on a genuinely unknown subdomain after unrelated edits", async () => {
    const { open, macroErrors } = harness();
    await open("main.ddd", `system S { }\nui Web with scaffold(subdomains: [Typo]) { }\n`);
    expect(macroErrors("main.ddd")).toHaveLength(1);

    // An unrelated sibling appears — the bogus ref must NOT be silently hidden.
    await open("sales.ddd", SALES);
    expect(macroErrors("main.ddd")).toHaveLength(1);
  });
});
