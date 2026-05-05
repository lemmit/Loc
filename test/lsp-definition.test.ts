import { describe, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { expectGoToDefinition } from "langium/test";
import { createDddServices } from "../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Go-to-definition tests.  Each test marks the cursor with `<|>`
// (index 0) and the expected target range with `<|...|>` (rangeIndex 0).
//
// Verifies Langium's default definition provider resolves every
// cross-reference grammar element correctly.  Where the default
// fails, the test calls out the gap so we know which override to ship.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;
const expectDef = expectGoToDefinition(services);

describe("DefinitionProvider — built-in cross references", () => {
  it("Id<X> jumps to the Aggregate", async () => {
    await expectDef({
      text: `
        context Sales {
          aggregate <|Order|> {
            customerId: string
          }
          aggregate Customer {
            primaryOrder: Id<<|>Order>
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("contains lines: <Part> jumps to the EntityPart", async () => {
    await expectDef({
      text: `
        context Sales {
          aggregate Order {
            entity <|OrderLine|> {
              qty: int
            }
            contains lines: <|>OrderLine[]
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("named-type ref jumps to the ValueObject", async () => {
    await expectDef({
      text: `
        context Sales {
          valueobject <|Money|> {
            amount: decimal
            currency: string
          }
          aggregate Order {
            price: <|>Money
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("enum-typed property jumps to the EnumDecl", async () => {
    await expectDef({
      text: `
        context Sales {
          enum <|Status|> { Open, Closed }
          aggregate Order {
            status: <|>Status
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("repository ... for X jumps to the Aggregate", async () => {
    await expectDef({
      text: `
        context Sales {
          aggregate <|Order|> {
            customerId: string
          }
          repository Orders for <|>Order { }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("emit ... jumps to the EventDecl", async () => {
    await expectDef({
      text: `
        context Sales {
          event <|OrderConfirmed|> {
            order: Id<Order>
          }
          aggregate Order {
            customerId: string
            operation confirm() {
              emit <|>OrderConfirmed { order: id }
            }
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("modules: <Module> jumps to the Module declaration", async () => {
    await expectDef({
      text: `
        system Acme {
          module <|Sales|> {
            context S { aggregate Order { x: int } }
          }
          deployable api {
            platform: hono
            modules: <|>Sales
            port: 3000
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("targets: <Deployable> jumps to the Deployable", async () => {
    await expectDef({
      text: `
        system Acme {
          module Sales {
            context S { aggregate Order { x: int } }
          }
          deployable <|api|> {
            platform: hono
            modules: Sales
            port: 3000
          }
          deployable web {
            platform: react
            targets: <|>api
            port: 5173
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });
});

describe("DefinitionProvider — member access", () => {
  it("`this.<col>` jumps to the Property declaration", async () => {
    await expectDef({
      text: `
        context Sales {
          aggregate Order {
            <|customerId|>: string
            function ownerId(): string = this.<|>customerId
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("`this.<containment>` jumps to the Containment declaration", async () => {
    await expectDef({
      text: `
        context Sales {
          aggregate Order {
            entity OrderLine { qty: int }
            contains <|lines|>: OrderLine[]
            derived count: int = this.<|>lines.count
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });

  it("`this.<vo>.<sub>` jumps to the value-object Property", async () => {
    await expectDef({
      text: `
        context Sales {
          valueobject Money {
            <|amount|>: decimal
            currency: string
          }
          aggregate Order {
            price: Money
            derived priceAmount: decimal = this.price.<|>amount
          }
        }`,
      index: 0,
      rangeIndex: 0,
    });
  });
});
