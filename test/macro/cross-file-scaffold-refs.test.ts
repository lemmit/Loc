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
    const remove = async (rel: string): Promise<void> => {
      fs.rmSync(path.join(dir, rel));
      await shared.workspace.DocumentBuilder.update([], [uri(rel)]);
    };
    const errors = (rel: string, match: RegExp): string[] =>
      (shared.workspace.LangiumDocuments.getDocument(uri(rel))?.diagnostics ?? [])
        .filter((d) => (d.severity ?? 4) <= 2 && match.test(d.message))
        .map((d) => d.message);
    const macroErrors = (rel: string): string[] => errors(rel, UNKNOWN_SUBDOMAIN);
    return { open, remove, errors, macroErrors };
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

  it("re-errors when the resolved provider file is removed", async () => {
    const { open, remove, macroErrors } = harness();
    await open("sales.ddd", SALES);
    await open(
      "main.ddd",
      `import "./sales.ddd"\nsystem S { }\nui Web with scaffold(subdomains: [Sales]) { }\n`,
    );
    // Clean to start with — Sales resolves.
    expect(macroErrors("main.ddd")).toEqual([]);

    // Deleting the provider must re-validate the host (its refs tracked Sales's
    // document) and surface the now-dangling ref — not leave a stale green.
    await remove("sales.ddd");
    expect(macroErrors("main.ddd")).toHaveLength(1);
  });

  // A page body referencing a top-level `component` by name is the *same* class
  // of by-name cross-document reference as a macro arg (resolved in the
  // validator against the workspace index, not via Langium's linker), and is
  // re-validated through the same affected-doc path (the `loom.unknown-builder-type`
  // hungry-retry).  This is what the ERP example's deploy.ddd relies on.
  it("clears a cross-file top-level component reference once its file loads", async () => {
    const { open, errors } = harness();
    const UNKNOWN_BUILDER = /Unknown builder type 'Banner'/;

    // Page uses `Banner`, declared in a sibling that hasn't loaded yet.
    await open(
      "main.ddd",
      `system S { }\nui Web {\n  page Home { route: "/", body: Stack { Banner { } } }\n}\n`,
    );
    expect(errors("main.ddd", UNKNOWN_BUILDER)).toHaveLength(1);

    // The component's file lands later: the page must re-validate and clear.
    await open("lib.ddd", `component Banner { body: Text { "hi" } }\n`);
    expect(errors("main.ddd", UNKNOWN_BUILDER)).toEqual([]);
  });
});
