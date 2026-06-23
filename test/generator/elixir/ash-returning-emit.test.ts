import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `emit` inside an Ash returning-op generic action (DEBT-03).  A returning op
// (`operation foo(): Agg or NotFound { … }`) lowers to an Ash 3.x generic
// action; an `emit` in its body renders the same `Phoenix.PubSub.broadcast`
// the regular Ash op body / workflow emits — no persistence, so it fits the
// in-memory run fn.  `add`/`remove` stay gated on ash (manage_relationship
// needs a changeset).
// ---------------------------------------------------------------------------

const SOURCE = `
system Inventory {
  subdomain Ops {
    context Stock {
      error NotFound { resource: string }
      event Adjusted { sku: string, delta: int }
      aggregate Item ids guid {
        sku: string
        quantity: int
        operation adjust(delta: int): Item or NotFound {
          precondition delta != 0
          quantity := quantity + delta
          emit Adjusted { sku: sku, delta: delta }
        }
      }
      repository Items for Item { }
    }
  }
  api InventoryApi from Ops
  storage pg { type: postgres }
  resource itemState { for: Stock, kind: state, use: pg }
  deployable phoenixApp {
    platform: elixir { foundation: ash }
    contexts: [Stock]
    dataSources: [itemState]
    serves: InventoryApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("Ash returning-op `emit` (DEBT-03)", () => {
  it("renders a PubSub broadcast inside the generic action, before the success term", async () => {
    const item = file(await generateSystemFiles(SOURCE), "/stock/item.ex");
    // The generic action.
    expect(item).toContain("action :adjust, :term do");
    // The emit → the canonical Ash broadcast form (context PubSub + Events struct).
    expect(item).toContain(
      'Phoenix.PubSub.broadcast(PhoenixApp.Stock.PubSub, "events", %PhoenixApp.Stock.Events.Adjusted{sku: record.sku, delta: delta})',
    );
    // …then the aggregate-success fall-through term.
    expect(item).toContain("{:ok, {:success,");
    // Order: the broadcast precedes the success term.
    const broadcastIdx = item.indexOf("Phoenix.PubSub.broadcast");
    const successIdx = item.indexOf("{:ok, {:success,");
    expect(broadcastIdx).toBeGreaterThan(-1);
    expect(broadcastIdx).toBeLessThan(successIdx);
  });
});
