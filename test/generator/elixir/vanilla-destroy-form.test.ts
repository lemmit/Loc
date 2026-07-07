import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Vanilla-Phoenix DestroyForm seam (gap §10, docs/plans/vanilla-phoenix-gaps.md).
//
// A detail page hosting `DestroyForm(of: <Agg>)` hoists a `handle_event`
// whose body calls `<Ctx>.destroy_<agg>!(id)` directly (a `byId`
// ActionBinding — see heex-primitives.ts).  The vanilla context module must
// therefore EMIT that bang destroy function, or `mix compile
// --warnings-as-errors` fails on the undefined call.
// ---------------------------------------------------------------------------

const SRC = `
system DestroyDemo {
  subdomain Catalog {
    context Inventory {
      aggregate Widget with crudish {
        name: string
      }
    }
  }
  api InventoryApi from Catalog
  ui Admin {
    page Widgets {
      route: "/widgets"
      body: Stack { Heading { "Widgets" } }
    }
    page WidgetDetail(id: Widget id) {
      route: "/widgets/:id"
      body: Stack { Heading { "Widget" }, DestroyForm(of: Widget) }
    }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [Inventory],
    serves: InventoryApi, ui: Admin, port: 4000
  }
}
`;

async function contextModule(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/inventory.ex")) return c;
  }
  throw new Error("Inventory context module not found");
}

describe("vanilla DestroyForm context seam (gap §10)", () => {
  it("emits the bang destroy function the LiveView DestroyForm calls", async () => {
    const ctx = await contextModule();
    // The DestroyForm's hoisted handle_event calls `<Ctx>.destroy_widget!(id)`.
    expect(ctx).toMatch(/def destroy_widget!\(id\)/);
  });

  it("loads the record by id, then hard-deletes it", async () => {
    const ctx = await contextModule();
    expect(ctx).toMatch(/case get_widget\(id\) do/);
    expect(ctx).toMatch(/Repo\.delete!\(record\)/);
  });

  it("does not emit a bang destroy for an aggregate without a destroy action", async () => {
    const noDestroy = `
system NoDestroy {
  subdomain S {
    context Inv {
      aggregate Gadget {
        name: string
      }
    }
  }
  api InvApi from S
  deployable phoenixApp {
    platform: elixir, contexts: [Inv],
    serves: InvApi, port: 4000
  }
}
`;
    const files = await generateSystemFiles(noDestroy);
    const ctx = [...files].find(([p]) => p.endsWith("/inv.ex"))?.[1] ?? "";
    expect(ctx).not.toMatch(/def destroy_gadget!/);
  });
});
