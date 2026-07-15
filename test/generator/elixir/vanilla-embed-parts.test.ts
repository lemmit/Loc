import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-32 — nested entity parts on a shape: embedded vanilla (plain Ecto)
// aggregate.  `contains lines: Line[]` persists as an Ecto `embeds_many` over a
// part `embedded_schema` module (the vanilla analogue of Ash's embedded
// resource), stored inline in the parent's jsonb column.  A containment-mutating
// op (`lines += Line{…}`) appends the struct to the threaded record and
// `put_embed`s the list.  Verified end-to-end against real Postgres (create →
// addLine → read round-trip) by the elixir-vanilla-build gate fixture.
// ---------------------------------------------------------------------------

const SOURCE = `
system Emb {
  subdomain Core {
    context Shop {
      aggregate Order shape: embedded {
        code: string
        contains lines: Line[]
        entity Line { sku: string  qty: int }
        operation addLine(sku: string, qty: int) { lines += Line { sku: sku, qty: qty } }
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource orderState { for: Shop, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Shop]
    dataSources: [orderState]
    serves: CatalogApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla embedded entity parts (DEBT-32)", () => {
  it("the root schema embeds_many the part (no field, no child table)", async () => {
    const order = file(await generateSystemFiles(SOURCE), "/shop/order.ex");
    expect(order).toContain("embeds_many :lines, Api.Shop.Line");
    expect(order).not.toContain("field :lines");
  });

  it("emits the part as an Ecto embedded_schema module with a Jason encoder + changeset", async () => {
    const line = file(await generateSystemFiles(SOURCE), "/shop/line.ex");
    expect(line).toContain("use Ecto.Schema");
    expect(line).toContain("@derive {Jason.Encoder, only: [:id, :sku, :qty]}");
    expect(line).toContain("embedded_schema do");
    expect(line).toContain("field :sku, :string");
    expect(line).toContain("field :qty, :integer");
    expect(line).toContain("def changeset(struct, attrs)");
    expect(line).toContain("cast(attrs, [:sku, :qty])");
  });

  it("base_changeset cast_embeds the containment (forces the embed into create/update)", async () => {
    const cs = file(await generateSystemFiles(SOURCE), "/shop/order_changeset.ex");
    expect(cs).toContain("|> cast_embed(:lines)");
  });

  it("the addLine op appends the part struct and put_embeds the list", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/shop.ex");
    expect(ctx).toContain(
      "record = %{record | lines: (record.lines || []) ++ [%Api.Shop.Line{sku: sku, qty: qty}]}",
    );
    expect(ctx).toContain("|> Ecto.Changeset.put_embed(:lines, record.lines)");
  });

  it("the embedded containment migration column is nullable jsonb (empty embed → NULL → []) ", async () => {
    const files = await generateSystemFiles(SOURCE);
    const mig = file(files, "_create_orders.exs");
    expect(mig).toContain("add :lines, :map, null: true");
  });
});
