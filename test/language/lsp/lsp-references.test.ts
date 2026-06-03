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

describe("ReferencesProvider — shadowing & callables", () => {
  // Guards the shared `nameRefDecl`/`localShadows` fix: the lambda body `total`
  // is bound to the shadowing lambda param, so it is NOT a reference to the
  // property.  Only the declaration and `this.total` are marked → the lambda
  // body must not appear in the result.
  it("excludes a member reference shadowed by a lambda param", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate Order {
            <|><|total|>: int
            nums: int[]
            function f(): int = nums.sum(total => total) + this.<|total|>
          }
        }`,
      includeDeclaration: true,
    });
  });

  it("finds a property used in a derived expression", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate Order {
            <|><|rate|>: int
            derived doubled: int = this.<|rate|> * 2
          }
        }`,
      includeDeclaration: true,
    });
  });

  it("finds `this.<op>()` call sites of an operation from its declaration", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate Order {
            total: int
            operation <|><|close|>() { total := 0 }
            operation drain() { this.<|close|>() }
          }
        }`,
      includeDeclaration: true,
    });
  });
});

describe("ReferencesProvider — bare function calls", () => {
  // The bare-call fallback in `nameRefDecl` (entity-member lookup) now resolves
  // `tax()` to the function, so its references include the bare call site.
  it("finds a bare function-call site from the declaration", async () => {
    await expectRefs({
      text: `
        context Sales {
          aggregate Order {
            rate: int
            function <|><|tax|>(): int = rate
            derived total: int = <|tax|>()
          }
        }`,
      includeDeclaration: true,
    });
  });
});

describe("ReferencesProvider — enum values", () => {
  // Enum-value use sites are string-token NameRefs (bare `Open`) and qualified
  // `Status.Open` MemberSuffixes — neither is a cross-reference.  Both resolve
  // to the value declaration through the shared `qualifiedEnumValueDecl` /
  // `resolveEnumValue` fallbacks, so find-references reaches both forms.
  it("finds bare and qualified use sites of an enum value", async () => {
    await expectRefs({
      text: `
        context Sales {
          enum Status { <|><|Open|>, Closed }
          aggregate Order {
            st: Status
            operation a() { st := <|Open|> }
            operation b() { st := Status.<|Open|> }
          }
        }`,
      includeDeclaration: true,
    });
  });
});
