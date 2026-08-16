// LiveView `Action { c.<op> }` button → hoisted `handle_event` clause.  When the
// operation reads `currentUser` (a `requires currentUser.…` gate, a
// `currentUser`-sourced assign), `context-emit.ts` gives its bang fn a trailing
// `current_user \\ nil` arity and the HTTP action threads
// `conn.assigns[:current_user]`.  The LiveView seam called it at ARITY 1 — the
// default argument makes that compile, so the guard silently evaluated against
// `nil` instead of the signed-in principal.  It now threads the socket's
// principal, exactly as the HTTP path threads the conn's.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function system(gate: string): string {
  return `
system Acme {
  user { id: string  role: string }
  subdomain Sales {
    context Sales {
      aggregate Customer {
        name: string
        status: string
        operation confirm() { ${gate}  status := "confirmed" }
        operation cancel() { status := "cancelled" }
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin {
    api Sales: SalesApi
    page Detail {
      route: "/customers/:id"
      body: QueryView {
        of: Sales.Customer.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "Not found" },
        data: c => Toolbar { Action { c.confirm }, Action { c.cancel } }}
    }
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    ui: SalesAdmin { Sales: phoenixApp }
    port: 4000
    auth: required
  }
}
`;
}

async function files(gate: string): Promise<Map<string, string>> {
  return generateSystemFiles(system(gate));
}

function pick(all: Map<string, string>, suffix: string): string {
  const hit = [...all.entries()].find(([k]) => k.endsWith(suffix));
  if (!hit) throw new Error(`${suffix} not emitted`);
  return hit[1];
}

describe("LiveView Action button actor threading", () => {
  it("threads the socket principal into a currentUser-reading op", async () => {
    const all = await files('requires currentUser.role == "manager"');
    const live = pick(all, "/detail_live.ex");
    expect(live).toContain(
      "Sales.confirm_customer!(record, Map.get(socket.assigns, :current_user))",
    );
    // The context fn it calls really does carry the extra arity — this is the
    // half that made the arity-1 call silent rather than a compile error.
    const ctx = pick(all, "lib/phoenix_app/sales.ex");
    expect(ctx).toContain("def confirm_customer!(record, current_user \\\\ nil) do");
  });

  it("leaves an op that never reads currentUser at arity 1", async () => {
    const all = await files('requires currentUser.role == "manager"');
    const live = pick(all, "/detail_live.ex");
    expect(live).toContain("Sales.cancel_customer!(record)");
    expect(live).not.toContain("Sales.cancel_customer!(record, ");
  });
});
