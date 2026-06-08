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
    expect(plus, "no String() wrapping of the numeric operand").not.toContain("String(this.amount)");
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

  it("a TPH concrete subtype's repository delete targets the shared base table", async () => {
    const files = await gen(`
      context Crm {
        abstract aggregate Contact inheritanceUsing(sharedTable) {
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
});
