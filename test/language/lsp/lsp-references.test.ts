import { NodeFileSystem } from "langium/node";
import { expectFindReferences } from "langium/test";
import { describe, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Find-all-references tests.  `<|>` marks each cursor the search fires from;
// `<|...|>` marks every expected reference (with includeDeclaration, that
// includes the declaration).  Cross-reference targets come from Langium's
// index; member-access usages (`this.x`, bare member refs) come from the
// DddReferencesProvider fallback.  `<|><|ident|>` = cursor at the start of a
// reference that is itself in the expected set.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;
const expectRefs = expectFindReferences(services);

describe("ReferencesProvider — cross references", () => {
  it("finds X id usages of an aggregate from its declaration", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate <|><|Order|> {
            customerId: string
          }
          aggregate Customer {
            primaryOrder: <|Order|> id
          }
        }`,
      includeDeclaration: true,
    });
  });
});

describe("ReferencesProvider — member access", () => {
  it("finds `this.<prop>` usages from the property declaration", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate Order {
            <|><|customerId|>: string
            function ownerId(): string = this.<|customerId|>
          }
        }`,
      includeDeclaration: true,
    });
  });

  it("finds containment usages from the declaration", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate Order {
            entity OrderLine { qty: int }
            contains <|><|lines|>: OrderLine[]
            derived count: int = this.<|lines|>.count
          }
        }`,
      includeDeclaration: true,
    });
  });
});
