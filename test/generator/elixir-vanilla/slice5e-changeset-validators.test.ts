import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// T2.i — per-field constraint validators in the vanilla Ecto changeset.  The
// single-field-invariant classifier (`singleFieldConstraints`, shared with
// Zod / FluentValidation / the Java validator) drives idiomatic Ecto
// `validate_number` / `validate_length` / `validate_format` calls.
// ---------------------------------------------------------------------------

const SRC = `
system S {
  subdomain Core {
    context Shop {
      aggregate Product with crudish {
        name: string
        price: int
        sku: string
        invariant price >= 0
        invariant name.length <= 50
        invariant sku.matches("[A-Z]{3}")
      }
      repository Products for Product { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Shop] dataSources: [st] serves: A port: 4000 }
}
`;

describe("vanilla — T2.i changeset field-constraint validators", () => {
  it("maps single-field invariants to validate_number/length/format", async () => {
    const files = await generateSystemFiles(SRC);
    const cs = files.get([...files.keys()].find((k) => k.endsWith("/shop/product_changeset.ex"))!)!;
    expect(cs).toContain("|> validate_number(:price, greater_than_or_equal_to: 0)");
    expect(cs).toContain("|> validate_length(:name, max: 50)");
    expect(cs).toContain("|> validate_format(:sku, ~r/[A-Z]{3}/)");
  });

  it("applies the field validators on the UPDATE path too (SYS-1 parity)", async () => {
    // M-T6.8/SYS-1: Phoenix reaches update-path parity BY CONSTRUCTION — the
    // crudish `update` routes through `update_changeset`, which carries the SAME
    // single-field validators as `base_changeset`, so an invalid update is
    // rejected by the changeset (no emitter change needed, unlike the other four
    // backends).  Since versioning is default-on (M-T3.4) the update seam pipes
    // through the optimistic-lock-guarded `update_changeset` rather than
    // `base_changeset`; this pins that it still carries the field validators.
    const files = await generateSystemFiles(SRC);
    const repo = files.get(
      [...files.keys()].find((k) => k.endsWith("/shop/product_repository.ex"))!,
    )!;
    expect(repo).toMatch(/def update\([\s\S]*?update_changeset\(/);
    const cs = files.get([...files.keys()].find((k) => k.endsWith("/shop/product_changeset.ex"))!)!;
    expect(cs).toMatch(
      /def update_changeset\([\s\S]*?validate_number\(:price, greater_than_or_equal_to: 0\)/,
    );
  });

  it("keeps base_changeset validator-free when the aggregate has no field invariants", async () => {
    const plain = `
system P {
  subdomain Core {
    context Tracker {
      aggregate Task with crudish { title: string }
      repository Tasks for Task { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Tracker, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Tracker] dataSources: [st] serves: A port: 4000 }
}
`;
    const f = await generateSystemFiles(plain);
    const cs = f.get([...f.keys()].find((k) => k.endsWith("/tracker/task_changeset.ex"))!)!;
    expect(cs).not.toContain("validate_number");
    expect(cs).not.toContain("validate_length");
    expect(cs).not.toContain("validate_format");
  });
});
