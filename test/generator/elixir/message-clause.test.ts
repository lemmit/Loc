import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Custom validation messages on the vanilla Phoenix/Ecto backend — a messaged
// single-field rule rides its author text on Ecto's own `message:` option of
// the native `validate_*` line (keeping enforcement + surfacing the text); a
// messaged cross-field rule surfaces it on the `validate_invariants/1`
// `add_error`. A message-less rule keeps its native validator + the derived
// `must satisfy:` default, byte-identical.
// ---------------------------------------------------------------------------

const SRC = `
system S {
  subdomain Sales {
    context Cat {
      aggregate Product {
        sku: string check sku.length > 0 message "SKU is required"
        name: string
        invariant name.length >= 2 && name.length <= 120 message "Name must be 2-120 characters"
        invariant sku.length > 0
        create(n: string, s: string) { name := n  sku := s }
      }
      repository Products for Product { }
    }
  }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

async function changeset() {
  const all = await generateSystemFiles(SRC);
  const key = [...all.keys()].find((k) => k.endsWith("cat/product_changeset.ex"))!;
  return all.get(key)!;
}

describe("elixir/vanilla — messaged rule → Ecto message: option", () => {
  it("carries the author text on the native validate_* line", async () => {
    const cs = await changeset();
    expect(cs).toContain(
      '|> validate_length(:name, min: 2, message: "Name must be 2-120 characters")',
    );
    expect(cs).toContain(
      '|> validate_length(:name, max: 120, message: "Name must be 2-120 characters")',
    );
    expect(cs).toContain('|> validate_length(:sku, min: 1, message: "SKU is required")');
  });

  it("keeps a message-LESS single-field rule byte-identical (no message: option)", async () => {
    const cs = await changeset();
    expect(cs).toContain("|> validate_length(:sku, min: 1)\n");
  });
});
