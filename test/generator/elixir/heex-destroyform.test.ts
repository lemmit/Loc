import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx DestroyForm (parity finding #5).  `DestroyForm(of: <Agg>)` on a detail
// page renders a confirm-delete `<.button>` wired to the aggregate's Ash
// destroy code-interface (`destroy_<agg>!(id)`) via a `byId` ActionBinding,
// and navigates to the aggregate's list route on success.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain S {
    context Sales {
      aggregate Order with crudish {
        total: int
      }
    }
  }
  api ShopApi from S
  ui ShopUi {
    page OrderList {
      route: "/orders"
      body: Stack { Heading { "Orders" } }
    }
    page OrderDetail(id: Order id) {
      route: "/orders/:id"
      body: Stack { Heading { "Order" }, DestroyForm(of: Order) }
    }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [Sales], serves: ShopApi,
    ui: ShopUi, port: 4000
  }
}
`;

async function detailLive(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("_live.ex") && c.includes("destroy_order")) return c;
  }
  throw new Error("LiveView with destroy_order not found");
}

describe("HEEx DestroyForm (parity finding #5)", () => {
  it("renders a confirm-delete button carrying the route id", async () => {
    const live = await detailLive();
    expect(live).toMatch(/phx-click="destroy_order"/);
    expect(live).toContain("phx-value-id={@id}");
    expect(live).toMatch(/data-confirm="/);
  });

  it("hoists a destroy handle_event that calls the Ash destroy interface by id", async () => {
    const live = await detailLive();
    expect(live).toMatch(/def handle_event\("destroy_order", %\{"id" => id\}, socket\)/);
    // byId: calls the interface with the id directly (no get-then-destroy).
    expect(live).toMatch(/\.destroy_order!\(id\)/);
    expect(live).not.toMatch(/get_order!\(id\)\n\s*\S*\.destroy_order!/);
  });

  it("navigates to the aggregate list route after delete", async () => {
    const live = await detailLive();
    expect(live).toMatch(/push_navigate\(to: ~p"\/orders"\)/);
  });
});
