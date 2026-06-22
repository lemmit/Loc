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
  deployable api { platform: node            contexts: [C] serves: SApi port: 3000 }
  deployable px  { platform: elixir contexts: [C] serves: SApi port: 4000 }
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
    // owner FK + ordinal + the value object's flattened columns.  The owner is
    // a guid-id aggregate, so the FK is uuid (lockstep with the migration).
    expect(schema).toMatch(/parentId:\s*uuid\("order_id"\)\.notNull\(\)/);
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

describe("value-object collection — migration (relational child table, all backends)", () => {
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

  it("the Phoenix migration creates the id-less child table and drops the parent column", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // A dedicated child-table migration (synthetic uuid PK + parent FK +
    // ordinal + flattened VO columns) — NOT an inline `{:array, :map}` column.
    const child = findFile(files, /px\/.*migrations\/.*create_order_charges\.exs$/);
    expect(child).toMatch(/create table\(:order_charges, primary_key: false/);
    expect(child).toMatch(/add :id, :uuid, primary_key: true/);
    expect(child).toMatch(
      /add :order_id, references\(:orders, type: :uuid, on_delete: :delete_all\), null: false/,
    );
    expect(child).toMatch(/add :ordinal, :integer, null: false/);
    expect(child).toMatch(/add :amount, :decimal/);
    expect(child).toMatch(/add :currency, :text/);
    // The parent migration carries no `charges` column.
    const orders = findFile(files, /px\/priv\/repo\/migrations\/.*create_orders\.exs$/);
    expect(orders).not.toMatch(/:charges/);
    expect(orders).not.toMatch(/\{:array, :map\}/);
  });

  it("the Phoenix Ash resource models the VO array as a child has_many, stripped from the wire", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const order = findFile(files, /px\/.*\/order\.ex$/);
    // `has_many` onto the child resource, ordinal-ordered; managed via
    // `manage_relationship`; the field is gone from the attributes block.
    expect(order).toMatch(/has_many :charges, \S+\.OrderCharges do\s+sort ordinal: :asc/);
    expect(order).toMatch(
      /change manage_relationship\(:charges, :charges, type: :direct_control\)/,
    );
    expect(order).not.toMatch(/attribute :charges/);
    // The child resource Jason-encodes ONLY the value object's own fields —
    // synthetic id / parent FK / ordinal stripped, so the wire stays
    // `[{amount,currency},…]`.
    const child = findFile(files, /px\/.*\/order_charges\.ex$/);
    expect(child).toMatch(/uuid_primary_key :id/);
    expect(child).toMatch(/attribute :order_id, :uuid/);
    expect(child).toMatch(/attribute :ordinal, :integer/);
    expect(child).toMatch(/encode_struct\(value, \[:amount, :currency\], opts\)/);
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
  deployable api { platform: node contexts: [C] serves: SApi port: 3000 }
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
