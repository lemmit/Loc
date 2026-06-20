// shape(embedded) on the Phoenix/Ash backend: contained parts become
// Ash *embedded* resources (`data_layer: :embedded`) stored inline in a
// jsonb column on the root via `attribute :lines, {:array, Line}` —
// instead of child tables + `has_many`.  Mirrors EF owned-`.ToJson()`
// (.NET) and the Drizzle jsonb column (TS).  The `mix compile` gate
// lives in test/e2e/generated-elixir-ash-build.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order shape(embedded) {
        name: string
        contains lines: Line[]
        entity Line {
          sku: string
          invariant sku.length > 0
        }
      }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp {}
  deployable api {
    platform: phoenix
    contexts: [Orders]
    dataSources: [ordersState]
    ui: WebApp
    port: 4000
  }
}
`;

async function generate(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC))).files;
}

function find(files: Map<string, string>, pred: (k: string) => boolean, label: string): string {
  const key = [...files.keys()].find(pred);
  expect(key, `${label} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("Phoenix shape(embedded) — Ash embedded resources", () => {
  it("root folds the containment into an embedded array attribute (no has_many, no part table)", async () => {
    const files = await generate();
    const order = find(files, (k) => k.endsWith("/orders/order.ex"), "order.ex");
    expect(order).toContain("attribute :lines, {:array,");
    expect(order).toContain(".Orders.Line}, default: []");
    expect(order).not.toContain("has_many :lines");
    const mig = find(files, (k) => k.includes("migrations") && k.endsWith(".exs"), "migration");
    expect(mig).toContain("create table(:orders");
    expect(mig).toContain("add :lines, :map");
    expect(mig).not.toContain("create table(:lines");
  });

  it("the part is an embedded resource — no table, no parent FK, not domain-registered", async () => {
    const files = await generate();
    const line = find(files, (k) => k.endsWith("/orders/line.ex"), "line.ex");
    expect(line).toContain("data_layer: :embedded");
    expect(line).not.toContain("postgres do");
    expect(line).not.toContain("belongs_to");
    expect(line).not.toContain("order_id");
    expect(line).not.toContain("domain: ");
    // Embedded part must NOT appear in the domain module's resources block.
    const domain = find(
      files,
      (k) => k.endsWith("/orders.ex") && !k.includes("/orders/"),
      "domain",
    );
    expect(domain).toContain(".Orders.Order do");
    expect(domain).not.toContain(".Orders.Line");
  });
});
