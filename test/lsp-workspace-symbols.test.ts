import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { CancellationToken, SymbolKind } from "vscode-languageserver";
import { createDddServices } from "../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Workspace-symbol tests — exercise the auto-registered
// `DefaultWorkspaceSymbolProvider` through shared services + verify the
// custom `DddNodeKindProvider` returns informative `SymbolKind` values
// (Class for aggregates / value objects, Enum for enums, etc.).
//
// Loads every example .ddd file into the workspace via the shared
// document builder, then queries the provider directly.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function buildWorkspaceFromExamples() {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const builder = services.shared.workspace.DocumentBuilder;
  const examples = ["sales.ddd", "banking.ddd", "inventory.ddd", "acme.ddd"];
  const built = await Promise.all(
    examples.map((name) =>
      docs.getOrCreateDocument(URI.file(path.join(repoRoot, "examples", name))),
    ),
  );
  await builder.build(built, { validation: false });
  return services;
}

describe("DefaultWorkspaceSymbolProvider with DddNodeKindProvider", () => {
  it("returns Order from sales.ddd via 'Order' query, kind = Class", async () => {
    const services = await buildWorkspaceFromExamples();
    const provider = services.shared.lsp.WorkspaceSymbolProvider!;
    const symbols = await provider.getSymbols({ query: "Order" }, CancellationToken.None);
    const order = symbols.find((s) => s.name === "Order");
    expect(order, JSON.stringify(symbols.map((s) => s.name))).toBeDefined();
    expect(order!.kind).toBe(SymbolKind.Class);
  });

  it("returns enum values with Enum kind", async () => {
    const services = await buildWorkspaceFromExamples();
    const provider = services.shared.lsp.WorkspaceSymbolProvider!;
    const symbols = await provider.getSymbols({ query: "OrderStatus" }, CancellationToken.None);
    const status = symbols.find((s) => s.name === "OrderStatus");
    expect(status, JSON.stringify(symbols.map((s) => s.name))).toBeDefined();
    expect(status!.kind).toBe(SymbolKind.Enum);
  });

  it("returns value objects with Class kind", async () => {
    const services = await buildWorkspaceFromExamples();
    const provider = services.shared.lsp.WorkspaceSymbolProvider!;
    const symbols = await provider.getSymbols({ query: "Money" }, CancellationToken.None);
    const money = symbols.find((s) => s.name === "Money");
    expect(money).toBeDefined();
    expect(money!.kind).toBe(SymbolKind.Class);
  });

  // Events are deliberately scoped to their bounded context (not exported
  // globally — see `DddScopeComputation.computeExports`).  Workspace
  // symbols therefore won't surface them, which matches the local-scope
  // semantic the validator enforces.

  it("matches across multiple loaded documents", async () => {
    // Sanity check that the provider sees symbols from every example,
    // not just the first one parsed.
    const services = await buildWorkspaceFromExamples();
    const provider = services.shared.lsp.WorkspaceSymbolProvider!;
    const allSymbols = await provider.getSymbols({ query: "" }, CancellationToken.None);
    const names = new Set(allSymbols.map((s) => s.name));
    expect(names.has("Order")).toBe(true); // sales.ddd
    expect(names.has("Account")).toBe(true); // banking.ddd
    expect(names.has("Product")).toBe(true); // inventory or acme
  });
});
