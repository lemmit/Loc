import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Custom validation messages on the vanilla Phoenix/Ecto backend — a messaged
// rule (single-field OR cross-field) routes through the `validate_invariants/1`
// residual carrier, whose `add_error` carries the author text AND the stable
// content-hash wire `code` as `loom_code:` metadata (Ecto's native validators
// can't carry a custom key). A message-LESS single-field rule keeps its native
// `validate_*` line, byte-identical.
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

describe("elixir/vanilla — messaged single-field rule → residual carrier + wire code", () => {
  it("routes a messaged single-field rule through validate_invariants with loom_code", async () => {
    const cs = await changeset();
    // `.length` predicates render against the applied struct via String.length,
    // add_error carries the author text + the content-hash wire code.
    expect(cs).toContain(
      'if String.length(data.name) >= 2 and String.length(data.name) <= 120, do: changeset, else: add_error(changeset, :name, "Name must be 2-120 characters", loom_code: "msg.j985f2")',
    );
    expect(cs).toContain(
      'if String.length(data.sku) > 0, do: changeset, else: add_error(changeset, :sku, "SKU is required", loom_code: "msg.u3w71r")',
    );
    // A messaged rule no longer emits a native validate_* line with `message:`.
    expect(cs).not.toContain('message: "Name must be 2-120 characters"');
    expect(cs).not.toContain('message: "SKU is required"');
  });

  it("keeps a message-LESS single-field rule byte-identical on the native validator", async () => {
    const cs = await changeset();
    expect(cs).toContain("|> validate_length(:sku, min: 1)\n");
  });
});

// A messaged CROSS-FIELD rule likewise routes through the `validate_invariants/1`
// residual carrier, whose `add_error` carries the stable content-hash wire
// `code` as `loom_code:` metadata; the 422 handler surfaces it as
// `errors[].code`.
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
