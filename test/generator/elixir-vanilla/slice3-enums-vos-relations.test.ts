import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 3 of docs/plans/vanilla-foundation-tdd-plan.md — enums, value
// objects, and id-relationships in the vanilla schema emit.
//
// Slice 1 only exercised primitives.  Slice 3 verifies the schema
// emitter handles the richer wireShape constituents that the Ash path
// already supports:
//   - enum → `Ecto.Enum, values: [:foo, :bar]`
//   - valueobject → `:map` (JSONB) — Slice's wire-parity baseline
//   - X id (foreign-key reference) → `:binary_id`
//   - optional<T> → unwraps to T's Ecto column type
//   - T[] array → `{:array, T}`
// ---------------------------------------------------------------------------

const RICH_SOURCE = `
system Catalog {
  subdomain Sales {
    context Storefront {
      enum OrderStatus { Pending Confirmed Shipped Cancelled }

      valueobject Money {
        amount: decimal
        currency: string
      }

      aggregate Customer with crudish {
        name: string
      }

      aggregate Order with crudish {
        customerId: Customer id
        status: OrderStatus
        total: Money
        tags: string[]
        notes: string?
      }
      repository Orders for Order { }
      repository Customers for Customer { }
    }
  }
  api StorefrontApi from Sales
  storage primary { type: postgres }
  resource storefrontState { for: Storefront, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Storefront]
    dataSources: [storefrontState]
    serves: StorefrontApi
    port: 4000
  }
}
`;

describe("vanilla — Slice 3 enums + VOs + relationships in schema-emit", () => {
  it("emits an enum field as `Ecto.Enum, values: [...]`", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const schema = files.get([...files.keys()].find((k) => k.endsWith("/storefront/order.ex"))!)!;
    // Enum values use the DECLARED casing (unquoted atoms), matching the wire
    // contract — not snake — so the column casts/round-trips "Pending" etc.
    expect(schema).toMatch(
      /field :status, Ecto\.Enum, values: \[:Pending, :Confirmed, :Shipped, :Cancelled\]/,
    );
  });

  it("emits a valueobject field as `:map` (JSONB)", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const schema = files.get([...files.keys()].find((k) => k.endsWith("/storefront/order.ex"))!)!;
    expect(schema).toContain("field :total, :map");
  });

  it("emits an `X id` foreign-key field as `:binary_id`", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const schema = files.get([...files.keys()].find((k) => k.endsWith("/storefront/order.ex"))!)!;
    expect(schema).toContain("field :customer_id, :binary_id");
  });

  it("emits an optional<string> field as just `:string` (the wrapper unwraps)", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const schema = files.get([...files.keys()].find((k) => k.endsWith("/storefront/order.ex"))!)!;
    expect(schema).toContain("field :notes, :string");
  });

  it("emits a string[] array field as `{:array, :string}`", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const schema = files.get([...files.keys()].find((k) => k.endsWith("/storefront/order.ex"))!)!;
    expect(schema).toContain("field :tags, {:array, :string}");
  });

  it("Customer schema (primitives only) still emits cleanly (Slice 1 regression)", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const schema = files.get(
      [...files.keys()].find((k) => k.endsWith("/storefront/customer.ex"))!,
    )!;
    expect(schema).toContain("field :name, :string");
    expect(schema).toContain('schema "customers" do');
  });

  it("Changeset emits @all_fields covering all Order fields (incl. customer_id)", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const cs = files.get(
      [...files.keys()].find((k) => k.endsWith("/storefront/order_changeset.ex"))!,
    )!;
    expect(cs).toContain("@all_fields [");
    expect(cs).toContain(":customer_id");
    expect(cs).toContain(":status");
    expect(cs).toContain(":total");
    expect(cs).toContain(":tags");
    expect(cs).toContain(":notes");
  });

  it("Notes field is optional → not in @required_fields", async () => {
    const files = await generateSystemFiles(RICH_SOURCE);
    const cs = files.get(
      [...files.keys()].find((k) => k.endsWith("/storefront/order_changeset.ex"))!,
    )!;
    const requiredMatch = cs.match(/@required_fields \[([^\]]*)\]/);
    expect(requiredMatch).toBeDefined();
    const required = requiredMatch![1];
    expect(required).not.toContain(":notes");
  });
});
