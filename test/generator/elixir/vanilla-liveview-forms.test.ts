// ---------------------------------------------------------------------------
// Slice 2-B — vanilla LiveView FORM lifecycle (Ecto changeset, no Ash).
//
// A `foundation: vanilla` deployable with a `scaffold`ed `ui:` emits
// create / operation forms.  The Ash path drives these via
// `AshPhoenix.Form.*`; the vanilla path swaps them for plain Ecto
// changesets (`change_<agg>` facade + `create_<agg>`/`update_<agg>`
// context calls).  These assertions pin the vanilla form lifecycle and
// guard the Ash output from drifting.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = `
  system FormShop {
    subdomain Sales {
      context Sales {
        valueobject Money {
          amount: decimal
          currency: string
        }
        aggregate Customer {
          name: string
          email: string
          creditLimit: Money
          invariant email.length > 0
          operation adjustCredit(amount: decimal) {
            precondition amount > 0
          }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    ui SalesAdmin with scaffold(subdomains: [Sales]) { }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable phoenixApp {
      platform: elixir
      contexts: [Sales]
      dataSources: [salesState]
      serves: SalesApi
      ui: SalesAdmin
      port: 4000
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE);
}

function get(fs: Map<string, string>, suffix: string): string {
  const key = [...fs.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending in ${suffix}; have:\n${[...fs.keys()].join("\n")}`);
  return fs.get(key)!;
}

describe("vanilla LiveView forms — create form (2-B)", () => {
  it("mounts a blank Ecto changeset via the change_<agg> facade (no AshPhoenix.Form.for_create)", async () => {
    const live = get(await files(), "/live/customer_new_live.ex");
    expect(live).toContain(
      "|> assign(:form, PhoenixApp.Sales.change_customer(%PhoenixApp.Sales.Customer{}) |> to_form())",
    );
    expect(live).not.toContain("AshPhoenix.Form.for_create");
  });

  it("emits a save_<agg> submit handler over create_<agg> with changeset-error re-assign", async () => {
    const live = get(await files(), "/live/customer_new_live.ex");
    expect(live).toContain('def handle_event("save_customer", %{"customer" => params}, socket) do');
    expect(live).toContain("case PhoenixApp.Sales.create_customer(params) do");
    expect(live).toContain('|> push_navigate(to: ~p"/customers")');
    expect(live).toContain(
      "{:error, %Ecto.Changeset{} = changeset} ->\n        {:noreply, assign(socket, :form, to_form(changeset))}",
    );
  });
});

describe("vanilla LiveView forms — operation form (2-B)", () => {
  it("seeds the op-form from the loaded record via change_<agg> in handle_params (no for_update)", async () => {
    const live = get(await files(), "/live/customer_detail_live.ex");
    expect(live).toContain(
      "|> assign(:adjust_credit_form, PhoenixApp.Sales.change_customer(record) |> to_form())",
    );
    expect(live).not.toContain("AshPhoenix.Form.for_update");
  });

  it("validate builds a changeset with action: :validate (no AshPhoenix.Form.validate)", async () => {
    const live = get(await files(), "/live/customer_detail_live.ex");
    expect(live).toContain('def handle_event("validate_adjust_credit"');
    expect(live).toContain("|> PhoenixApp.Sales.change_customer(params)");
    expect(live).toContain("|> Map.put(:action, :validate)");
    expect(live).not.toContain("AshPhoenix.Form.validate");
  });

  it("submit persists via update_<agg> and re-seeds the form (no AshPhoenix.Form.submit)", async () => {
    const live = get(await files(), "/live/customer_detail_live.ex");
    expect(live).toContain('def handle_event("submit_adjust_credit"');
    expect(live).toContain("case PhoenixApp.Sales.update_customer(socket.assigns.data, params) do");
    expect(live).toContain("{:error, %Ecto.Changeset{} = changeset} ->");
    expect(live).not.toContain("AshPhoenix.Form.submit");
  });
});

describe("vanilla — change_<agg> facade (2-B)", () => {
  it("delegates to the per-aggregate Changeset module's base_changeset/2", async () => {
    const ctx = get(await files(), "/lib/phoenix_app/sales.ex");
    expect(ctx).toContain(
      "def change_customer(record_or_struct \\\\ %PhoenixApp.Sales.Customer{}, attrs \\\\ %{}),\n    do: PhoenixApp.Sales.CustomerChangeset.base_changeset(record_or_struct, attrs)",
    );
  });
});
