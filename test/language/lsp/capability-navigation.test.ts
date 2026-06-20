// LSP navigation for typed capabilities (typed-capabilities.md, Phase 5).
//
// Capability references (`with <Cap>` / `implements <Cap>`) resolve by name
// through the expander inventory, not a Langium cross-reference, so the default
// providers can't navigate them.  These tests pin the custom bridges:
//   - go-to-definition: from a `with`/`implements` use to the `capability` decl
//   - find-references:  from a `capability` decl to its use sites (implementors)

import { NodeFileSystem } from "langium/node";
import { validationHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import type { Position } from "vscode-languageserver";
import { createDddServices } from "../../../src/language/ddd-module.js";

// Fresh services per call so the workspace holds exactly one document — the
// cross-file capability scan would otherwise see leftover docs from sibling
// tests (the find/go-to scan is workspace-wide by design).
function freshServices() {
  return createDddServices(NodeFileSystem).Ddd;
}

/** Position of the `needle` occurrence at or after `from` (byte offset). */
function posAt(source: string, needle: string, from = 0): Position {
  const offset = source.indexOf(needle, from);
  if (offset < 0) throw new Error(`needle "${needle}" not found`);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

const SRC = `
capability tenantRegistry { parent: Self id? }
system D { subdomain M { context C {
  aggregate Org with tenantRegistry { name: string }
  aggregate Region { label: string  implements tenantRegistry }
}}}
`;

describe("capability LSP navigation (typed-capabilities.md Phase 5)", () => {
  it("go-to-definition: `with tenantRegistry` → the capability declaration", async () => {
    const Ddd = freshServices();
    const { document } = await validationHelper(Ddd)(SRC);
    const uri = document.textDocument.uri;
    const pos = posAt(SRC, "tenantRegistry", SRC.indexOf("with tenantRegistry"));
    const links = await Ddd.lsp.DefinitionProvider!.getDefinition(document, {
      textDocument: { uri },
      position: pos,
    });
    expect(links?.length).toBe(1);
    // The target's selection range points at the declaration's name line.
    const declLine = SRC.slice(0, SRC.indexOf("capability tenantRegistry")).split("\n").length - 1;
    expect(links![0]!.targetSelectionRange.start.line).toBe(declLine);
  });

  it("go-to-definition: `implements tenantRegistry` → the capability declaration", async () => {
    const Ddd = freshServices();
    const { document } = await validationHelper(Ddd)(SRC);
    const uri = document.textDocument.uri;
    const pos = posAt(SRC, "tenantRegistry", SRC.indexOf("implements tenantRegistry"));
    const links = await Ddd.lsp.DefinitionProvider!.getDefinition(document, {
      textDocument: { uri },
      position: pos,
    });
    expect(links?.length).toBe(1);
  });

  it("find-references: the capability declaration lists both implementors", async () => {
    const Ddd = freshServices();
    const { document } = await validationHelper(Ddd)(SRC);
    const uri = document.textDocument.uri;
    const pos = posAt(SRC, "tenantRegistry"); // first occurrence = the declaration
    const refs = await Ddd.lsp.ReferencesProvider.findReferences(document, {
      textDocument: { uri },
      position: pos,
      context: { includeDeclaration: false },
    });
    // The `with tenantRegistry` and `implements tenantRegistry` use sites.
    expect(refs.length).toBe(2);
  });

  it("go-to-definition returns nothing for a built-in capability (no source decl)", async () => {
    const src = `
system D { subdomain M { context C {
  aggregate Order with auditable { subject: string }
}}}
`;
    const Ddd = freshServices();
    const { document } = await validationHelper(Ddd)(src);
    const uri = document.textDocument.uri;
    const pos = posAt(src, "auditable", src.indexOf("with auditable"));
    const links = await Ddd.lsp.DefinitionProvider!.getDefinition(document, {
      textDocument: { uri },
      position: pos,
    });
    expect(links ?? []).toHaveLength(0);
  });
});
