import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// T2.c tail — returning-op body statements on the elixir vanilla foundation
// (exception-less.md "Two-regime split" + success-path serialisation).  Beyond
// the return-only path (slice5c), a returning op may carry guards, mutations,
// and event emits in its body:
//   - `precondition` / `requires` → raise guards (bug-shaped / forbidden),
//   - `assign field := value`    → struct-update the threaded `record`,
//   - `emit Event { … }`         → Phoenix.PubSub broadcast,
//   - fall-through success        → `{:ok, %{…wireShape…}}` (wire-ready map).
// ---------------------------------------------------------------------------

const source = `
system L {
  subdomain Core {
    context Stock {
      error NotFound { resource: string }
      event Adjusted { sku: string, delta: int }
      aggregate Item with crudish {
        sku: string
        quantity: int
        operation adjust(delta: int): Item or NotFound {
          precondition delta != 0
          requires quantity + delta >= 0
          quantity := quantity + delta
          emit Adjusted { sku: sku, delta: delta }
        }
      }
      repository Items for Item { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Stock, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Stock]
    dataSources: [st]
    serves: A
    port: 4000
  }
}
`;

describe("vanilla — T2.c returning-op body statements", () => {
  const files = () => generateSystemFiles(source);
  const get = (m: Map<string, string>, suffix: string) =>
    m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

  it("renders precondition/requires as raise guards", async () => {
    const ctx = get(await files(), "lib/api/stock.ex");
    expect(ctx).toContain(
      'if not (delta != 0), do: raise(ArgumentError, "Precondition failed: delta != 0")',
    );
    expect(ctx).toContain(
      'if not (record.quantity + delta >= 0), do: raise(ArgumentError, "Forbidden: quantity + delta >= 0")',
    );
  });

  it("renders `assign` as a struct-update on the threaded record", async () => {
    const ctx = get(await files(), "lib/api/stock.ex");
    expect(ctx).toContain("record = %{record | quantity: record.quantity + delta}");
  });

  it("hoists `emit` past the persist — broadcast fires AFTER persist_change commits (S5a)", async () => {
    const ctx = get(await files(), "lib/api/stock.ex");
    // The event struct is bound + broadcast inside the {:ok, saved} branch.
    expect(ctx).toContain(
      "loom_event_0 = %Api.Stock.Events.Adjusted{sku: record.sku, delta: delta}",
    );
    expect(ctx).toContain('Phoenix.PubSub.broadcast(Api.PubSub, "events", loom_event_0)');
    // Ordering: persist_change comes BEFORE the broadcast (no phantom event on a
    // failed write).
    const persistAt = ctx.indexOf("ItemRepository.persist_change(changeset)");
    const bcastAt = ctx.indexOf('Phoenix.PubSub.broadcast(Api.PubSub, "events", loom_event_0)');
    expect(persistAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(bcastAt);
    // No saga in this context → no Dispatcher routing (broadcast-only).
    expect(ctx).not.toContain("Stock.Dispatcher.dispatch");
  });

  it("returns the wire-ready success tuple off the SAVED struct when the body falls through", async () => {
    const ctx = get(await files(), "lib/api/stock.ex");
    expect(ctx).toContain("{:ok, %{id: saved.id, sku: saved.sku, quantity: saved.quantity}}");
    // A persist validation failure surfaces as {:error, changeset}.
    expect(ctx).toContain("{:error, changeset} ->");
  });

  it("controller still translates the tagged result to HTTP", async () => {
    const ctl = get(await files(), "/controllers/item_controller.ex");
    expect(ctl).toContain("adjust_item_result(conn, Stock.adjust_item(record, attrs))");
    expect(ctl).toContain("def adjust_item_result(conn, {:ok, success})");
    expect(ctl).toContain('problem_variant(conn, 404, "/errors/not-found", "Not Found", data)');
  });
});
