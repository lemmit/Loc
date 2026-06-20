import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Mirrors the Hono/.NET seed fixtures, targeting a `phoenixLiveView`
// deployable.  App module derives from the deployable name `web` → `Web`.
const FIXTURE = `system AcmeSeed {
  subdomain Shop {
    context Catalog {
      enum Tier { Free, Pro }
      valueobject Money { amount: decimal currency: string }
      aggregate Product with crudish {
        sku: string
        price: Money
        tier: Tier
        stock: int
      }
      repository Products for Product { }

      seed default {
        Product { sku: "BASE-1", price: Money { amount: 1.0, currency: "USD" }, tier: Free, stock: 1 }
      }
      seed demo {
        Product { sku: "DEMO-1", price: Money { amount: 9.99, currency: "USD" }, tier: Pro, stock: 10 }
      }
    }
  }
  api ShopApi from Shop
  deployable web {
    platform: elixir
    contexts: [Catalog]
    serves: ShopApi
    port: 4000
  }
}
`;

async function build(src = FIXTURE): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("phoenix database seeding (Phase 3b, domain path)", () => {
  it("emits seeds.exs going through the Ash create action with named VO structs", async () => {
    const seeds = (await build()).get("web/priv/repo/seeds.exs")!;
    expect(seeds).toBeDefined();

    // Through the domain create action (D-SEED-PATH).
    expect(seeds).toContain(
      'Web.Catalog.create_product!(%{sku: "BASE-1", price: %Web.Catalog.Money{amount: 1.0, currency: "USD"}, tier: :free, stock: 1})',
    );
    expect(seeds).toContain(
      'Web.Catalog.create_product!(%{sku: "DEMO-1", price: %Web.Catalog.Money{amount: 9.99, currency: "USD"}, tier: :pro, stock: 10})',
    );
  });

  it("is ship-once per dataset via the __loom_seed marker (D-SEED-IDEMPOTENCY)", async () => {
    const seeds = (await build()).get("web/priv/repo/seeds.exs")!;
    expect(seeds).toContain('CREATE TABLE IF NOT EXISTS "__loom_seed"');
    expect(seeds).toContain("already_seeded?");
    expect(seeds).toContain("mark_seeded");
  });

  it("gates non-default datasets on LOOM_SEED; default always runs", async () => {
    const seeds = (await build()).get("web/priv/repo/seeds.exs")!;
    expect(seeds).toContain('System.get_env("LOOM_SEED")');
    expect(seeds).toContain('dataset == "default" or MapSet.member?(requested, dataset)');
    expect(seeds).toContain(
      'if dataset_enabled?.("default") and not already_seeded?.("default") do',
    );
    expect(seeds).toContain('if dataset_enabled?.("demo") and not already_seeded?.("demo") do');
  });

  it("runs seeds.exs from the ecto.setup mix alias", async () => {
    const mix = (await build()).get("web/mix.exs")!;
    expect(mix).toContain(
      '"ecto.setup": ["ecto.create", "ash.codegen", "ash.migrate", "run priv/repo/seeds.exs"]',
    );
  });

  it("emits the empty stub and leaves ecto.setup untouched when no seed block is declared", async () => {
    const noSeed = FIXTURE.replace(/seed default \{[\s\S]*?\n {6}\}\n/, "").replace(
      /seed demo \{[\s\S]*?\n {6}\}\n/,
      "",
    );
    const files = await build(noSeed);
    expect(files.get("web/priv/repo/seeds.exs")).toBe("# Auto-generated — empty seeds stub.\n");
    expect(files.get("web/mix.exs")!).toContain(
      '"ecto.setup": ["ecto.create", "ash.codegen", "ash.migrate"]',
    );
    expect(files.get("web/mix.exs")!).not.toContain("run priv/repo/seeds.exs");
  });
});

describe("phoenix seeding — raw explicit-id path", () => {
  const RAW = `system S {
    subdomain Sales { context Sales {
      aggregate Customer with crudish { name: string }
      aggregate Order with crudish { customerId: Customer id status: string }
      repository Customers for Customer { }
      repository Orders for Order { }
      seed reference raw {
        Customer { id: "c1", name: "Acme" }
        Order { id: "o1", customerId: "c1", status: "new" }
      }
    } }
    api A from Sales
    ui U with scaffold(subdomains: [Sales]) { }
    storage p { type: postgres }
    resource st { for: Sales, kind: state, use: p }
    deployable web { platform: elixir contexts: [Sales] dataSources: [st] serves: A ui: U port: 4000 }
  }`;

  it("emits Ecto.Adapters.SQL INSERTs with explicit id + FK", async () => {
    const seeds = (await build(RAW)).get("web/priv/repo/seeds.exs")!;
    expect(seeds).toContain(
      'Ecto.Adapters.SQL.query!(repo, ~s(INSERT INTO "customers" ("id", "name") VALUES (\'c1\', \'Acme\')), [])',
    );
    expect(seeds).toContain('INSERT INTO "orders" ("id", "customer_id", "status")');
    expect(seeds).not.toContain("create_customer!");
  });
});
