import { NodeFileSystem } from "langium/node";
import { expectCompletion } from "langium/test";
import { describe, expect, it } from "vitest";
import { CompletionItemKind } from "vscode-languageserver";
import { createDddServices } from "../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Completion-provider tests.  Two surfaces:
//
//   1. Member-access completions — typing `.` on a typed receiver
//      should suggest type-driven members.
//   2. Cross-reference completions enriched with `detail` labels.
//
// Each test marks the cursor with `<|>` (index 0) and asserts the
// expected items via the assert callback.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;
const expectComp = expectCompletion(services);

describe("DddCompletionProvider — member access", () => {
  it("suggests entity members after `.` on an entity receiver", async () => {
    await expectComp({
      text: `
        context Sales {
          aggregate Order {
            customerId: string
            placedAt: datetime
            function ownerId(): string = this.<|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const labels = list.items.map((i) => i.label);
        expect(labels, JSON.stringify(labels)).toContain("customerId");
        expect(labels).toContain("placedAt");
        expect(labels).toContain("id");
      },
    });
  });

  it("suggests collection ops after `.` on an array receiver", async () => {
    await expectComp({
      text: `
        context Sales {
          aggregate Order {
            entity OrderLine { qty: int }
            contains lines: OrderLine[]
            derived total: int = this.lines.<|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const labels = list.items.map((i) => i.label);
        expect(labels, JSON.stringify(labels)).toContain("count");
        expect(labels).toContain("sum");
        expect(labels).toContain("any");
        expect(labels).toContain("first");
      },
    });
  });

  it("suggests value-object members on `this.<vo>.`", async () => {
    await expectComp({
      text: `
        context Sales {
          valueobject Money {
            amount: decimal
            currency: string
          }
          aggregate Order {
            price: Money
            derived priceCurrency: string = this.price.<|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const labels = list.items.map((i) => i.label);
        expect(labels, JSON.stringify(labels)).toContain("amount");
        expect(labels).toContain("currency");
      },
    });
  });

  it("suggests `length` on string receiver", async () => {
    await expectComp({
      text: `
        context Sales {
          aggregate Order {
            customerId: string
            derived idLen: int = this.customerId.<|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const labels = list.items.map((i) => i.label);
        expect(labels, JSON.stringify(labels)).toContain("length");
      },
    });
  });

  it("suggests enum values on `EnumName.`", async () => {
    await expectComp({
      text: `
        context Sales {
          enum Status { Open, Closed, Draft }
          aggregate Order {
            status: Status
            function isOpen(): bool = this.status == Status.<|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const labels = list.items.map((i) => i.label);
        expect(labels, JSON.stringify(labels)).toContain("Open");
        expect(labels).toContain("Closed");
        expect(labels).toContain("Draft");
      },
    });
  });
});

describe("DddCompletionProvider — cross-reference enrichment", () => {
  it("aggregate cross-ref completions carry detail='aggregate'", async () => {
    await expectComp({
      text: `
        context Sales {
          aggregate Order {
            customerId: string
          }
          aggregate Customer {
            primaryOrder: Id<<|>>
          }
        }`,
      index: 0,
      assert: (list) => {
        const order = list.items.find((i) => i.label === "Order");
        expect(order, JSON.stringify(list.items.map((i) => i.label))).toBeDefined();
        expect(order!.detail).toBe("aggregate");
      },
    });
  });

  it("value-object cross-ref completions carry detail='valueobject'", async () => {
    await expectComp({
      text: `
        context Sales {
          valueobject Money {
            amount: decimal
            currency: string
          }
          aggregate Order {
            price: <|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const money = list.items.find((i) => i.label === "Money");
        expect(money).toBeDefined();
        expect(money!.detail).toBe("valueobject");
      },
    });
  });

  it("containment-part suggestions are aggregate-local only", async () => {
    // Regression guard for the existing DddScopeProvider rule.  Order
    // declares `OrderLine`; Account declares `Posting`.  When
    // completing `contains foo: ` inside Account, ONLY `Posting`
    // should appear — never `OrderLine`.
    await expectComp({
      text: `
        context Banking {
          aggregate Order {
            entity OrderLine { qty: int }
            contains lines: OrderLine[]
          }
          aggregate Account {
            entity Posting { amount: decimal }
            contains postings: <|>
          }
        }`,
      index: 0,
      assert: (list) => {
        const labels = list.items.map((i) => i.label);
        expect(labels).toContain("Posting");
        expect(labels, JSON.stringify(labels)).not.toContain("OrderLine");
      },
    });
  });
});

describe("DddServices wiring (completion)", () => {
  it("registers CompletionProvider", () => {
    expect(services.lsp.CompletionProvider).toBeDefined();
  });
});

void CompletionItemKind;
