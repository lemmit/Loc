import { describe, expect, it } from "vitest";
import { emitContext } from "../../../src/generator/elixir/context-emit.js";
import { emitAggregateResources } from "../../../src/generator/elixir/domain-emit.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";

// Phoenix/Ash TPH (sharedTable) emission — aggregate-inheritance.md I2.  Ash has
// no native single-table-inheritance, so the hierarchy maps to one table via
// multiple resources, each `base_filter`'d on a `kind` discriminator (value =
// the concrete's name, the cross-backend contract).  See
// docs/proposals/phoenix-tph-emission.md.

async function tphContext() {
  const model = await buildLoomModel(`
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) {
        name: string
        email: string
      }
      aggregate Customer extends Party { creditLimit: int }
      aggregate Vendor extends Party { rating: int }
      repository Customers for Customer { }
      repository Vendors for Vendor { }
    }
  `);
  return allContexts(model).find((c) => c.name === "Parties")!;
}

describe("Phoenix TPH emission", () => {
  it("a concrete maps to the shared base table, base_filter'd on its kind", async () => {
    const files = emitAggregateResources(await tphContext(), "App", "app");
    const customer = files.get("lib/app/parties/customer.ex") ?? "";
    // Shared table named for the base, not the concrete.
    expect(customer).toContain('table "parties"');
    expect(customer).not.toContain('table "customers"');
    // `kind` discriminator + per-concrete read scope.
    expect(customer).toContain('attribute :kind, :string, default: "Customer"');
    expect(customer).toContain('base_filter expr(kind == "Customer")');

    const vendor = files.get("lib/app/parties/vendor.ex") ?? "";
    expect(vendor).toContain('table "parties"');
    expect(vendor).toContain('base_filter expr(kind == "Vendor")');
  });

  it("the abstract base owns no resource", async () => {
    const files = emitAggregateResources(await tphContext(), "App", "app");
    expect(files.has("lib/app/parties/party.ex")).toBe(false);
  });

  it("the domain module gets a polymorphic `list_<base>` reader over the concretes", async () => {
    const out = new Map<string, string>();
    emitContext("app", await tphContext(), "App", out);
    const domain = out.get("lib/app/parties.ex") ?? "";
    expect(domain).toContain("def list_parties!, do: list_customers!() ++ list_vendors!()");
  });
});
