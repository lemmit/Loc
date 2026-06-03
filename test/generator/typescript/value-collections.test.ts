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
  deployable api { platform: hono contexts: [C] serves: SApi port: 3000 }
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
});
