// Vanilla foundation — Ecto schema emission (vanilla-foundation-tdd-plan.md
// slice 1). A `foundation: vanilla` Phoenix deployable emits a plain
// `Ecto.Schema` per aggregate (no Ash.Resource). The user-facing validator
// gate is still up, so this drives generation with `validate: false`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          total: int
          status: OrderStatus
        }
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: phoenix { foundation: vanilla }  contexts: [Ops]  port: 4000 }
  }
`;

async function vanillaFiles(): Promise<Map<string, string>> {
  // `foundation: vanilla` is still gated by the validator (R5), so bypass
  // validation — the emit path itself is what's under test.
  const { model } = await parseString(SRC, { validate: false });
  return generateSystems(model).files;
}

function get(files: Map<string, string>, suffix: string): string {
  const k = [...files.keys()].find((key) => key.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return files.get(k!)!;
}

describe("vanilla foundation — Ecto schema emit", () => {
  it("emits a plain Ecto.Schema per aggregate (no Ash.Resource)", async () => {
    const files = await vanillaFiles();
    const schema = get(files, "/ops/order.ex");
    expect(schema).toContain("defmodule Api.Ops.Order do");
    expect(schema).toContain("use Ecto.Schema");
    expect(schema).not.toContain("use Ash.Resource");
    expect(schema).toContain("@primary_key {:id, :binary_id, autogenerate: false}");
    expect(schema).toContain('schema "orders" do');
    expect(schema).toContain("field :total, :integer");
    // enum → stored string column (vanilla), not an Ash typed enum.
    expect(schema).toContain("field :status, :string");
    expect(schema).toContain("timestamps()");
  });

  it("emits the shared <App>.Types module", async () => {
    const files = await vanillaFiles();
    expect(get(files, "lib/api/types.ex")).toContain("defmodule Api.Types do");
  });
});
