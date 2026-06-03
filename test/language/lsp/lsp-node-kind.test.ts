import { AstUtils } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseDocument } from "langium/test";
import { describe, expect, it } from "vitest";
import { SymbolKind } from "vscode-languageserver";
import { createDddServices } from "../../../src/language/ddd-module.js";
import { DddNodeKindProvider } from "../../../src/language/lsp/ddd-node-kind.js";

// ---------------------------------------------------------------------------
// NodeKindProvider — workspace-symbol (Cmd+T) / completion icon kinds.  The
// provider had no tests; this pins the symbol-kind mapping, including the
// `Deployable → Module` fix (was the semantically-wrong `Constructor`).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;
const provider = new DddNodeKindProvider();

const MODEL = `system Shop {
  subdomain Sales {
    context Orders {
      enum Status { Open }
      aggregate Order {
        total: int
        operation close() {}
      }
      repository OrderRepo for Order {}
    }
  }
  deployable api {
    platform: dotnet
    contexts: [Orders]
  }
}`;

describe("NodeKindProvider — symbol kinds", () => {
  it("maps each declaration to a sensible SymbolKind", async () => {
    const doc = await parseDocument(services, MODEL);
    const byType = new Map<string, SymbolKind>();
    for (const node of AstUtils.streamAllContents(doc.parseResult.value)) {
      byType.set(node.$type, provider.getSymbolKind(node));
    }

    expect(byType.get("System")).toBe(SymbolKind.Package);
    expect(byType.get("Subdomain")).toBe(SymbolKind.Module);
    expect(byType.get("BoundedContext")).toBe(SymbolKind.Module);
    expect(byType.get("Aggregate")).toBe(SymbolKind.Class);
    expect(byType.get("EnumDecl")).toBe(SymbolKind.Enum);
    expect(byType.get("Operation")).toBe(SymbolKind.Method);
    expect(byType.get("Repository")).toBe(SymbolKind.Interface);
    // The fix: a deployable is a module-like deployment unit, not a Constructor.
    expect(byType.get("Deployable")).toBe(SymbolKind.Module);
  });
});
