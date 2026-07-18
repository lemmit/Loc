import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// B14 (docs/audits/behavioral-parity-bugs-2026-07.md) — an OPTIONAL single
// containment (`contains note: Memo?`) on a `shape: embedded` vanilla (plain
// Ecto) aggregate.  The vanilla backend is already null-safe here (unlike node /
// dotnet, which needed fixes): the containment folds into an `embeds_one`, and
// the wire serializer carries a `defp serialize_<part>(nil), do: nil` guard, so
// an unset containment round-trips as a null jsonb cell → `nil` → wire `null`.
// This test pins that behaviour so a future edit can't silently regress it.
// ---------------------------------------------------------------------------

const SOURCE = `
system EmbOpt {
  subdomain Core {
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
  api ShopApi from Core
  storage pg { type: postgres }
  resource orderState { for: Shop, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Shop], dataSources: [orderState], serves: ShopApi, port: 4000 }
}
`;

function file(files: Map<string, string>, suffix: RegExp): string {
  const key = [...files.keys()].find((k) => suffix.test(k));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("B14 — vanilla embedded optional single containment", () => {
  it("folds the optional single containment as an embeds_one", async () => {
    const order = file(await generateSystemFiles(SOURCE), /\/shop\/order\.ex$/);
    expect(order).toContain("embeds_one :note, D.Shop.Memo");
    expect(order).toContain("embeds_many :lines, D.Shop.LineItem");
  });

  it("null-guards the containment serializer (nil → nil)", async () => {
    const controller = file(await generateSystemFiles(SOURCE), /order_controller\.ex$/);
    expect(controller).toContain('"note" => serialize_memo(record.note)');
    expect(controller).toContain("defp serialize_memo(nil), do: nil");
  });
});
