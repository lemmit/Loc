import { NodeFileSystem } from "langium/node";
import { expectHover } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Hover-provider tests.  Each test places `<|>` markers in a small `.ddd`
// fixture and asserts the hover bubble's content (matched as a regex).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;
const expectHoverFor = expectHover(services);

describe("DddHoverProvider", () => {
  it("hovers an aggregate header with member counts", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          aggregate <|>Order {
            customerId: string
          }
        }`,
      index: 0,
      // 2 properties: the declared `customerId` + the default-on `version` token (M-T3.4).
      hover: /aggregate Order[\s\S]*2 propert/,
    });
  });

  it("hovers a property and shows its type", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          aggregate Order {
            <|>customerId: string
          }
        }`,
      index: 0,
      hover: /customerId: string/,
    });
  });

  it("hovers a containment and shows the part with collection marker", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          aggregate Order {
            entity OrderLine {
              qty: int
            }
            contains <|>lines: OrderLine[]
          }
        }`,
      index: 0,
      hover: /contains lines: OrderLine\[\]/,
    });
  });

  it("hovers a value-object name with property count", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          valueobject <|>Money {
            amount: decimal
            currency: string
          }
        }`,
      index: 0,
      hover: /valueobject Money[\s\S]*2 properties/,
    });
  });

  it("hovers an enum and lists its values", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          enum <|>Status { Open, Closed }
        }`,
      index: 0,
      hover: /enum Status[\s\S]*Open, Closed/,
    });
  });

  it("hovers a cross-reference target via X id", async () => {
    // The cursor sits on the cross-reference target identifier `Order`
    // inside `Order id`.  AstNodeHoverProvider resolves the ref to the
    // Aggregate declaration, so we get the aggregate hover content.
    await expectHoverFor({
      text: `
        context Sales {
          aggregate Order {
            customerId: string
          }
          aggregate Customer {
            primaryOrder: <|>Order id
          }
        }`,
      index: 0,
      hover: /aggregate Order/,
    });
  });

  it("hovers an entity-part declaration with enclosing aggregate", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          aggregate Order {
            entity <|>OrderLine {
              qty: int
            }
            contains lines: OrderLine[]
          }
        }`,
      index: 0,
      hover: /entity OrderLine in Order/,
    });
  });

  it("hovers a function declaration with signature", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          aggregate Order {
            qty: int
            function double(): int = qty * 2
            function <|>doubled(): int = qty * 2
          }
        }`,
      index: 0,
      hover: /function doubled\(\): int/,
    });
  });

  it("marks an unresolved containment part as «unresolved» (not a silent ?)", async () => {
    // The cursor sits on a containment whose part type doesn't resolve.  The
    // hover must surface the failure explicitly — `«unresolved: Missing»` —
    // rather than the old silent `?`, which read like a valid reference.
    await expectHoverFor({
      text: `
        context Sales {
          aggregate Order {
            contains <|>lines: Missing[]
          }
        }`,
      index: 0,
      hover: /contains lines: «unresolved: Missing»\[\]/,
    });
  });

  it("marks an unresolved repository aggregate as «unresolved»", async () => {
    await expectHoverFor({
      text: `
        context Sales {
          repository <|>Orders for Missing { }
        }`,
      index: 0,
      hover: /repository Orders for «unresolved: Missing»/,
    });
  });

  it("hovers a slot-typed component param and shows the slot type", async () => {
    // Without `DddType.slot` the hover would fall back to "unknown".
    // The variant makes it carry through `resolveTypeRef` → `typeToString`
    // and render correctly in the bubble.
    await expectHoverFor({
      text: `
        system S {
          ui WebApp {
            component DetailView(<|>heading: slot) {
              body: Stack { heading }
            }
          }
        }`,
      index: 0,
      hover: /heading: slot/,
    });
  });
});

// Sanity-check: services factory completes without throwing.
describe("DddServices wiring", () => {
  it("registers HoverProvider", () => {
    expect(services.lsp.HoverProvider).toBeDefined();
  });
});
