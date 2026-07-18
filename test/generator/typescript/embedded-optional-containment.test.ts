import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// B14 (node / Hono+Drizzle) — an OPTIONAL single containment on a
// `shape: embedded` aggregate (`contains note: Memo?`) folds into a NULLABLE
// jsonb column and hydrates through a null-guarded deserialiser.  A COLLECTION
// containment defaults to `[]` (never null) so stays `.notNull()`; a REQUIRED
// single containment is defaulted, so both keep the unguarded shape.
// ---------------------------------------------------------------------------

const SOURCE = `
system EmbOpt {
  subdomain Shop {
    context Shop {
      aggregate Order shape: embedded, with crudish {
        customer: string
        contains lines: LineItem[]
        contains note: Memo?
        entity LineItem { sku: string  qty: int }
        entity Memo { text: string }
        operation addLine(sku: string, qty: int) { lines += LineItem { sku: sku, qty: qty } }
      }
      repository Orders for Order { }
    }
  }
  api ShopApi from Shop
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable d { platform: node, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

async function file(re: RegExp): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  const key = [...files.keys()].find((k) => re.test(k));
  expect(key, `no file matched ${re}`).toBeDefined();
  return files.get(key!)!;
}

describe("B14 — node embedded optional single containment", () => {
  it("emits a NULLABLE jsonb column for the optional single containment", async () => {
    const schema = await file(/db\/schema\.ts$/);
    // `note` (optional single) → no `.notNull()`.
    expect(schema).toContain(`note: jsonb("note"),`);
    // `lines` (collection) → still `.notNull()`.
    expect(schema).toContain(`lines: jsonb("lines").notNull(),`);
  });

  it("null-guards the optional single containment on hydrate", async () => {
    const repo = await file(/repositories\/.*order/i);
    expect(repo).toContain(
      "const note = row.note == null ? null : memoFromDoc(row.note as MemoDoc);",
    );
    // The collection containment stays an unguarded `.map(...)`.
    expect(repo).toContain(
      "const lines = ((row.lines ?? []) as LineItemDoc[]).map((x) => lineItemFromDoc(x));",
    );
  });
});
