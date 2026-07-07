// Value objects flatten into the parent table's columns (standard DDD
// destructure), NOT a single json column.  This is the shape the relational
// ORMs already query — Drizzle `price_amount`/`price_currency`, EF owned
// types — so the canonical migration must match them, or the schema created
// at boot won't line up with the ORM (a runtime mismatch the no-op-DB gates
// mask).  Phoenix (vanilla Ecto) stores an embedded value object as one
// `:map`, so its migration regroups the flattened columns back into a single
// column.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const FIXTURE = `
system TV {
  subdomain S {
    context C {
      valueobject Money { amount: decimal currency: string }
      aggregate Order with crudish {
        name: string
        price: Money
      }
      repository Orders for Order { }
    }
  }
  api SApi from S
  deployable h { platform: node            contexts: [C] serves: SApi port: 3000 }
  deployable d { platform: dotnet          contexts: [C] serves: SApi port: 8080 }
  deployable p { platform: elixir contexts: [C] serves: SApi port: 4000 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}`);
}

describe("value-object migration — flatten into columns (relational) / :map (Ecto)", () => {
  it("the Hono migration flattens the value object into columns, not one JSONB", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const sql = findFile(files, /h\/db\/migrations\/.*\.sql$/);
    expect(sql).toMatch(/"price_amount"\s+DECIMAL/i);
    expect(sql).toMatch(/"price_currency"\s+TEXT/i);
    // No single json column for the value object.
    expect(sql).not.toMatch(/\bprice\s+JSONB\b/i);
  });

  it("the drizzle schema column names match the migration (so boot ⇄ ORM agree)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const schema = findFile(files, /h\/db\/schema\.ts$/);
    expect(schema).toMatch(/price_amount:\s*numeric\("price_amount"\)/);
    expect(schema).toMatch(/price_currency:\s*text\("price_currency"\)/);
  });

  it(".NET names the EF owned-type columns to match the migration's snake columns", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const cfg = findFile(files, /Configurations\/OrderConfiguration\.cs$/);
    // EF's default would be `Price_Amount`; the owned columns are named to
    // the migration's snake (`price_amount`) so the runtime schema agrees.
    expect(cfg).toMatch(/OwnsOne<Money>\(x => x\.Price, o => \{/);
    expect(cfg).toMatch(/\.HasColumnName\("price_amount"\)/);
    expect(cfg).toMatch(/\.HasColumnName\("price_currency"\)/);
    const migration = findFile(files, /d\/Migrations\/.*\.cs$/);
    // Inside the C# verbatim @"..." literal the SQL's double quotes are doubled.
    expect(migration).toMatch(/""price_amount""\s+DECIMAL/i);
  });

  it("the Phoenix migration regroups the columns back into a single :map", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const exs = findFile(files, /p\/priv\/repo\/migrations\/.*create_orders\.exs$/);
    expect(exs).toMatch(/add :price, :map/);
    expect(exs).not.toMatch(/add :price_amount/);
  });
});
