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

  it("colours type refs, callables, parameters, events, repositories and member calls", async () => {
    const tokens = await highlight(`
      context Sales {
        aggregate Customer { name: string }
        aggregate Order {
          buyer: <|Customer|> id
          function <|tax|>(<|rate|>: int): int = <|rate|>
          derived <|taxed|>: int = this.<|tax|>(1)
          operation <|charge|>() {}
        }
        event <|Charged|> { at: int }
        repository <|OrderRepo|> for Order {}
      }`);

    expectSemanticToken(tokens, { rangeIndex: 0, tokenType: SemanticTokenTypes.type }); // Customer (X id target)
    expectSemanticToken(tokens, { rangeIndex: 1, tokenType: SemanticTokenTypes.function }); // function tax
    expectSemanticToken(tokens, { rangeIndex: 2, tokenType: SemanticTokenTypes.parameter }); // rate param
    expectSemanticToken(tokens, { rangeIndex: 3, tokenType: SemanticTokenTypes.variable }); // rate (NameRef in fn body)
    expectSemanticToken(tokens, { rangeIndex: 4, tokenType: SemanticTokenTypes.property }); // taxed (derived)
    expectSemanticToken(tokens, { rangeIndex: 5, tokenType: SemanticTokenTypes.method }); // this.tax member (function → method)
    expectSemanticToken(tokens, { rangeIndex: 6, tokenType: SemanticTokenTypes.method }); // operation charge
    expectSemanticToken(tokens, { rangeIndex: 7, tokenType: SemanticTokenTypes.event }); // Charged
    expectSemanticToken(tokens, { rangeIndex: 8, tokenType: SemanticTokenTypes.type }); // OrderRepo (repository)
  });
});
