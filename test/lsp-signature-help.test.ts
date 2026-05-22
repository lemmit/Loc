import { describe, it, expect } from "vitest";
import { NodeFileSystem } from "langium/node";
import { parseDocument } from "langium/test";
import { createDddServices } from "../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Signature-help tests.  `<|>` marks the cursor inside a call's argument
// list; we strip it, request signature help, and assert the rendered label
// and active parameter.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;

async function sigAt(text: string) {
  const cursor = text.indexOf("<|>");
  const clean = text.replace("<|>", "");
  const doc = await parseDocument(services, clean);
  const position = doc.textDocument.positionAt(cursor);
  return services.lsp.SignatureHelp!.provideSignatureHelp(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position,
  });
}

describe("SignatureHelpProvider", () => {
  it("shows a function's parameters and active index", async () => {
    const help = await sigAt(`
      context Sales {
        aggregate Order {
          function discount(rate: decimal, cap: int): decimal = rate
          derived d: decimal = this.discount(0.1, <|>5)
        }
      }`);
    expect(help?.signatures[0].label).toBe("discount(rate: decimal, cap: int): decimal");
    expect(help?.activeParameter).toBe(1);
  });

  it("resolves a bare-name call to a function on the same aggregate", async () => {
    const help = await sigAt(`
      context Sales {
        aggregate Order {
          function tax(amount: decimal): decimal = amount
          derived t: decimal = tax(<|>)
        }
      }`);
    expect(help?.signatures[0].label).toBe("tax(amount: decimal): decimal");
    expect(help?.activeParameter).toBe(0);
  });
});
