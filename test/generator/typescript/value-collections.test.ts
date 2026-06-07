// Value-object collections (`field: <VO>[]`) persist as an id-less child
// table — columns flattened from the value object, keyed by
// (parent_id, ordinal).  A plain relational shape (no Postgres array /
// jsonb), so it ports to any SQL backend sharing the database.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system VA {
  subdomain S {
    context C {
      valueobject Money { amount: decimal currency: string }
      aggregate Order with crudish {
        name: string
        charges: Money[]
      }
      repository Orders for Order { }
    }
  }
  api SApi from S
  deployable api { platform: hono            contexts: [C] serves: SApi port: 3000 }
  deployable px  { platform: phoenixLiveView contexts: [C] serves: SApi port: 4000 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}`);
}

describe("value-object collection — child-table persistence (Hono)", () => {
  it("emits an id-less child table with the VO's flattened columns", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const schema = findFile(files, /db\/schema\.ts$/);
    // No scalar text() fallback for the VO array …
    expect(schema).not.toMatch(/charges:\s*text\(/);
    // … a dedicated child table instead.
    expect(schema).toMatch(/export const orderCharges = pgTable\("order_charges"/);
    // owner FK + ordinal + the value object's flattened columns
    expect(schema).toMatch(/parentId:\s*text\("order_id"\)\.notNull\(\)/);
    expect(schema).toMatch(/ordinal:\s*integer\("ordinal"\)\.notNull\(\)/);
    expect(schema).toMatch(/amount:\s*numeric\(/);
    expect(schema).toMatch(/currency:\s*text\(/);
    // keyed by (parent_id, ordinal), no surrogate id
    expect(schema).toMatch(/primaryKey\(\{ columns: \[table\.parentId, table\.ordinal\] \}\)/);
  });

  it("the repository loads child rows into the VO list and replaces them on save", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const repo = findFile(files, /order-repository\.ts$/);
    expect(repo).toMatch(
      /from\(schema\.orderCharges\)\.where\(eq\(schema\.orderCharges\.parentId, id\)\)\.orderBy\(schema\.orderCharges\.ordinal\)/,
    );
    expect(repo).toMatch(/new Money\(Number\(r\.amount\), r\.currency\)/);
    expect(repo).toMatch(
      /tx\.delete\(schema\.orderCharges\)\.where\(eq\(schema\.orderCharges\.parentId, aggregate\.id\)\)/,
    );
    expect(repo).toMatch(
      /tx\.insert\(schema\.orderCharges\)\.values\(\{ parentId: aggregate\.id as string, ordinal: i, amount: String\(e\.amount\), currency: e\.currency \}\)/,
    );
  });
});

describe("value-object collection — migration (relational child table / Ash :array of :map)", () => {
  it("the Hono migration creates the child table and drops the parent column", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const sql = findFile(files, /api\/db\/migrations\/.*\.sql$/);
    expect(sql).toMatch(/CREATE TABLE order_charges \(/);
    expect(sql).toMatch(/amount\s+DECIMAL/i);
    expect(sql).toMatch(/PRIMARY KEY \(order_id, ordinal\)/);
    // The parent table carries no `charges` column — the data is in the
    // child.  Bound the slice to the `orders` CREATE statement: FK
    // ordering now emits the parent before its `order_charges` child, so
    // slicing to end-of-file would wrongly pull in the child table.
    const ordersStart = sql.indexOf("CREATE TABLE orders");
    const ordersTable = sql.slice(ordersStart, sql.indexOf(");", ordersStart));
    expect(ordersTable).not.toMatch(/charges/);
  });

  it("the Phoenix migration stores the array inline as {:array, :map}, no child table", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const orders = findFile(files, /px\/priv\/repo\/migrations\/.*create_orders\.exs$/);
    expect(orders).toMatch(/add :charges, \{:array, :map\}/);
    // No separate child-table migration file.
    expect([...files.keys()].some((k) => /px\/.*order_charges\.exs$/.test(k))).toBe(false);
  });
});

// Optional fields whose wire type is already nullable (`Money[]?`) must emit
// `.nullish()` exactly once in the Hono response schema — `zodForResponse`
// used to add it for the `optional` flag on top of the type's own
// nullability, producing a redundant `.nullish().nullish()`.
const OPT_FIXTURE = `
system VB {
  subdomain S {
    context C {
      valueobject Money { amount: decimal currency: string }
      aggregate Bill with crudish {
        name: string
        note: string?
        surcharges: Money[]?
      }
      repository Bills for Bill { }
    }
  }
  api SApi from S
  deployable api { platform: hono contexts: [C] serves: SApi port: 3000 }
}
`;

describe("optional response fields — single .nullish()", () => {
  it("an optional T? / VO[]? field is not double-nullished in the response DTO", async () => {
    const files = await generateSystemFiles(OPT_FIXTURE);
    const routes = findFile(files, /bill\.routes\.ts$/);
    expect(routes).not.toMatch(/\.nullish\(\)\.nullish\(\)/);
    // …and the optional fields are still nullable (single).
    expect(routes).toMatch(/note:\s*z\.string\(\)\.nullish\(\)/);
    expect(routes).toMatch(/surcharges:\s*z\.array\(MoneySchema\)\.nullish\(\)/);
  });
});
