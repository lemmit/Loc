// ---------------------------------------------------------------------------
// Vanilla Elixir — relational deep part-in-part (M-T6.2 Drain C).
//
// A part that itself declares `contains` on a RELATIONAL (state-based) aggregate
// now persists as its OWN grandchild table.  Was gated
// (`loom.vanilla-containment-unsupported`) because the elixir migration emitter
// dropped a table FK'd to a sibling part (not a parent aggregate), and the part
// schema kept the nested containment an inline `embeds_many`.  These pin the
// drained surface: the grandchild migration (FK to the direct parent, in
// FK-topological order), the nested `has_many`/`belongs_to`/`cast_assoc`, and
// the nested read + update preload.  Boot-verified separately (nested create →
// read round-trip on real Postgres).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `system Warehouse {
  subdomain Core {
    context Orders {
      aggregate Order {
        name: string
        contains lines: Line[]
        entity Line { sku: string  contains tags: Tag[] }
        entity Tag { label: string }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Core
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Orders], dataSources: [ordersState], serves: OrdersApi, port: 4000 }
}`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("vanilla elixir relational part-in-part", () => {
  it("emits the grandchild `tags` migration FK'd to the direct parent `lines`", async () => {
    const all = await files();
    const tagMig = [...all.entries()].find(([p]) => /migrations\/.*create_tags\.exs$/.test(p));
    expect(tagMig).toBeDefined();
    const [tagPath, body] = tagMig!;
    expect(body).toContain("create table(:tags");
    expect(body).toContain(
      'add :line_id, references(:lines, prefix: "orders", type: :uuid, on_delete: :delete_all), null: false',
    );
    // FK-topological order: the grandchild `tags` migration timestamp trails its
    // parent `lines` migration (else `references(:lines)` runs before `lines` exists).
    const linesMig = [...all.keys()].find((p) => /migrations\/.*create_lines\.exs$/.test(p))!;
    const ts = (p: string) => Number(p.match(/migrations\/(\d+)_/)![1]);
    expect(ts(tagPath)).toBeGreaterThan(ts(linesMig));
  });

  it("emits the nested part `Line` as a relational has_many + cast_assoc of tags", async () => {
    const line = (await files()).get("api/lib/api/orders/line.ex")!;
    expect(line).toContain('schema "lines" do');
    expect(line).toContain(
      "has_many :tags, Api.Orders.Tag, foreign_key: :line_id, on_replace: :delete",
    );
    expect(line).toContain("belongs_to :order, Api.Orders.Order, foreign_key: :order_id");
    expect(line).toContain("|> cast_assoc(:tags)");
    // NOT the embedded fallback.
    expect(line).not.toContain("embeds_many :tags");
    expect(line).not.toContain("cast_embed(:tags)");
  });

  it("emits the grandchild part `Tag` table-backed, belongs_to its DIRECT parent `line`", async () => {
    const tag = (await files()).get("api/lib/api/orders/tag.ex")!;
    expect(tag).toContain('schema "tags" do');
    expect(tag).toContain("belongs_to :line, Api.Orders.Line, foreign_key: :line_id");
    // Its parent is the sibling part `line`, NOT the aggregate root `order`.
    expect(tag).not.toContain("belongs_to :order");
  });

  it("nests the read AND update preload `[lines: :tags]`", async () => {
    const repo = (await files()).get("api/lib/api/orders/order_repository.ex")!;
    expect(repo).toContain("Repo.preload([lines: :tags])");
    // No flat `[:lines]` preload left (it would leave `tags` NotLoaded → 500).
    expect(repo).not.toContain("Repo.preload([:lines])");
  });
});
