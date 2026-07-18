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

// A messaged CROSS-FIELD rule routes through the `validate_invariants/1`
// residual carrier, whose `add_error` carries the stable content-hash wire
// `code` as `loom_code:` metadata; the 422 handler surfaces it as
// `errors[].code`. (Single-field messaged rules stay on native Ecto validators,
// which can't carry a custom metadata key — so they get the message but no
// code; that's a documented Elixir limitation.)
const CROSS = `
system S {
  subdomain Sales {
    context Cat {
      aggregate Account with crudish {
        handle: string
        email: string
        invariant handle.length > 0
        invariant handle != email message "Handle and email must differ"
      }
      repository Accounts for Account { }
    }
  }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

describe("elixir/vanilla — messaged cross-field rule → wire code", () => {
  it("attaches loom_code metadata on the validate_invariants add_error", async () => {
    const all = await generateSystemFiles(CROSS);
    const cs = all.get([...all.keys()].find((k) => k.endsWith("cat/account_changeset.ex"))!)!;
    expect(cs).toContain(
      'add_error(changeset, :handle, "Handle and email must differ", loom_code: "msg.ggmd6x")',
    );
  });

  it("the 422 handler surfaces loom_code as errors[].code", async () => {
    const all = await generateSystemFiles(CROSS);
    const problem = all.get([...all.keys()].find((k) => k.endsWith("problem_details.ex"))!)!;
    expect(problem).toContain("case Keyword.get(opts, :loom_code) do");
    expect(problem).toContain("code -> Map.put(base, :code, code)");
  });
});
