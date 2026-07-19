// Regression coverage for the Acme-ERP multi-context Hono bundle: a set of
// generator bugs that only surfaced on a real multi-file workspace with an
// ambient shared kernel (root-level value objects / enums), a TPH aggregate
// hierarchy, `money`-typed events and server-managed datetime fields.  Each
// produced TypeScript that failed `tsc --noEmit` on the generated project.

import { describe, expect, it } from "vitest";
import { generateHono, parseString } from "../../_helpers/index.js";

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("; "));
  return generateHono(model);
}

describe("Hono ERP-bundle generator regressions", () => {
  it("a root value object's own function constructs itself with `new` and numeric arithmetic", async () => {
    // `Money.plus` returns a `Money { … }` literal referencing `Money` (and
    // its own `amount` field) from inside its own body — lowered with no
    // `env.ctx`.  Before the ambient decl index it lowered to a `free` call
    // (`Money(…)`, missing `new`) with the `+` mis-rendered as string concat.
    const files = await gen(`
      valueobject Money {
        amount: decimal
        currency: string
        function plus(other: Money): Money =
          Money { amount: amount + other.amount, currency: currency }
      }
      context Ledger {
        aggregate Entry {
          balance: Money
          create(balance: Money) { balance := balance }
        }
        repository Entries for Entry { }
      }
    `);
    const vo = files.get("domain/value-objects.ts") ?? "";
    const plus = vo.match(/plus\(other: Money\)[^\n]*/)?.[0] ?? "";
    expect(plus, "plus body located").not.toEqual("");
    expect(plus, "constructs with new").toContain("new Money(");
    expect(plus, "numeric add, not string concat").toContain("this.amount + other.amount");
    expect(plus, "no String() wrapping of the numeric operand").not.toContain(
      "String(this.amount)",
    );
  });

  it("value-object functions are public (invoked across aggregate boundaries)", async () => {
    const files = await gen(`
      valueobject Percentage {
        value: decimal
        function asFraction(): decimal = value / 100
      }
      context Sales {
        aggregate Deal {
          amount: decimal
          probability: Percentage
          derived weighted: decimal = amount * probability.asFraction()
          create(amount: decimal, probability: Percentage) {
            amount := amount
            probability := probability
          }
        }
        repository Deals for Deal { }
      }
    `);
    const vo = files.get("domain/value-objects.ts") ?? "";
    expect(vo, "asFraction emitted").toMatch(/asFraction\(\)/);
    expect(vo, "asFraction must NOT be private").not.toMatch(/private\s+asFraction/);
  });

  it("events with a `money`-typed field import Decimal", async () => {
    const files = await gen(`
      context Finance {
        event Debited { amount: money, at: datetime }
        aggregate Ledger {
          balance: money
          create(balance: money) { balance := balance }
        }
        repository Ledgers for Ledger { }
      }
    `);
    const events = files.get("domain/events.ts") ?? "";
    expect(events, "event uses Decimal").toContain("Decimal");
    expect(events, "Decimal is imported").toMatch(/import Decimal from "decimal\.js"/);
  });

  it("a domain test's `create({…})` coerces ids / value objects / datetimes to their domain types", async () => {
    const files = await gen(`
      context Sales {
        valueobject Address {
          line1: string
          line2: string?
          city: string
        }
        aggregate Order with crudish {
          reference: string
          buyerId: Order id
          shipTo: Address
          placedAt: datetime
          test "creates" {
            let o = Order.create({
              reference: "R1",
              buyerId: "00000000-0000-0000-0000-000000000001",
              shipTo: { line1: "1 Main St", city: "Town" },
              placedAt: "2020-01-01T00:00:00Z"
            })
            expect(o.reference).toBe("R1")
          }
        }
        repository Orders for Order { }
      }
    `);
    const test = files.get("domain/order.test.ts") ?? "";
    const create = test.match(/Order\.create\([\s\S]*?\}\);/)?.[0] ?? "";
    expect(create, "create call located").not.toEqual("");
    // `X id` string → branded ctor.
    expect(create, "id brands").toContain(
      'buyerId: Ids.OrderId("00000000-0000-0000-0000-000000000001")',
    );
    // bare object → VO ctor, omitted optional line2 filled with null.
    expect(create, "value object constructs, gap-filled").toContain(
      'shipTo: new Address("1 Main St", null, "Town")',
    );
    // datetime string → Date.
    expect(create, "datetime constructs").toContain('placedAt: new Date("2020-01-01T00:00:00Z")');
    // The raw untyped forms must be gone.
    expect(create, "no raw id string").not.toMatch(/buyerId:\s*"0000/);
    expect(create, "no bare shipTo object").not.toMatch(/shipTo:\s*\(?\{ line1:/);
  });

  it("a TPH concrete subtype's repository delete targets the shared base table", async () => {
    const files = await gen(`
      context Crm {
        abstract aggregate Contact inheritanceUsing: sharedTable {
          email: string
        }
        aggregate PersonContact extends Contact with crudish {
          firstName: string
        }
        repository PersonContacts for PersonContact { }
      }
    `);
    const repo = files.get("db/repositories/personContact-repository.ts") ?? "";
    const del = repo.match(/async delete\([\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(del, "delete method located").not.toEqual("");
    // The shared table is the base name pluralised (`contacts`), not the
    // subtype's own pluralisation (`personContacts`, which has no schema export).
    expect(del, "delete targets shared base table").toContain("schema.contacts");
    expect(del, "delete must NOT target the subtype table").not.toContain("schema.personContacts");
  });

  it("the TPH base reader imports decimal.js when a concrete has money inside a value object", async () => {
    // `Car.price: Money` where `Money.amount: money` — the concrete's only
    // money usage is inside a VO. The base reader's hydrate recurses into the
    // VO and emits `new Decimal(...)`, but the import gate keyed on the SHALLOW
    // `aggregateUsesMoney` (which doesn't resolve into VO fields), so the file
    // used `Decimal` without importing it → TS2304.
    const files = await gen(`
      valueobject Money { amount: money  currency: string }
      context Catalog {
        abstract aggregate Product inheritanceUsing: sharedTable { title: string }
        aggregate Car extends Product { price: Money }
        aggregate Bike extends Product { note: string }
        aggregate Depot { anchor: Product id }
        repository Cars for Car { }
        repository Bikes for Bike { }
        repository Depots for Depot { }
      }
    `);
    const baseReader = files.get("db/repositories/product-repository.ts") ?? "";
    expect(baseReader, "TPH base reader emitted").not.toEqual("");
    expect(baseReader, "base reader hydrates money via Decimal").toContain("new Decimal(");
    expect(baseReader, "base reader imports decimal.js").toContain('from "decimal.js"');
  });
});
