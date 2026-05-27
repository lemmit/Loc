import { NodeFileSystem } from "langium/node";
import { expectSemanticToken, highlightHelper } from "langium/test";
import { describe, it } from "vitest";
import { SemanticTokenTypes } from "vscode-languageserver";
import { createDddServices } from "../../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Semantic token tests.  `<|...|>` ranges mark the tokens we assert a type
// for (in document order, via rangeIndex).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;
const highlight = highlightHelper(services);

describe("SemanticTokenProvider", () => {
  it("colours declarations and member access by resolved kind", async () => {
    const tokens = await highlight(`
      context Sales {
        enum <|Status|> { <|Open|>, Closed }
        valueobject <|Money|> {
          <|amount|>: decimal
        }
        aggregate <|Order|> {
          <|total|>: decimal
          derived <|doubled|>: decimal = this.<|total|>
        }
      }`);

    expectSemanticToken(tokens, { rangeIndex: 0, tokenType: SemanticTokenTypes.enum }); // Status
    expectSemanticToken(tokens, { rangeIndex: 1, tokenType: SemanticTokenTypes.enumMember }); // Open
    expectSemanticToken(tokens, { rangeIndex: 2, tokenType: SemanticTokenTypes.struct }); // Money
    expectSemanticToken(tokens, { rangeIndex: 3, tokenType: SemanticTokenTypes.property }); // amount
    expectSemanticToken(tokens, { rangeIndex: 4, tokenType: SemanticTokenTypes.class }); // Order
    expectSemanticToken(tokens, { rangeIndex: 5, tokenType: SemanticTokenTypes.property }); // total
    expectSemanticToken(tokens, { rangeIndex: 6, tokenType: SemanticTokenTypes.property }); // doubled
    expectSemanticToken(tokens, { rangeIndex: 7, tokenType: SemanticTokenTypes.property }); // this.total member
  });
});
