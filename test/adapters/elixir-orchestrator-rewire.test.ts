// F7d — Phoenix orchestrator rewire — proves that the Phoenix
// orchestrator dispatches the `config :<app>, ash_domains: […]` block
// emission through `ashStyleAdapter.emitDi`.  Byte-identical
// guarantee comes from the existing Phoenix fixture suite + the
// page-emitter byte-equivalence fixture suite.
//
// Phoenix is always system-mode (the entry takes deployable + sys),
// so unlike F5d / F6d there's no legacy-mode branch to assert on.
// Per-aggregate Ash.Resource emission stays inline today — moving
// it through the persistence adapter is a follow-up because Ash
// emits at the per-CONTEXT granularity (not per aggregate).

import { describe, expect, it, vi } from "vitest";
import * as ashStyleModule from "../../src/generator/elixir/adapters/ash-style.js";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const SYSTEM_SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
      }
    }
    context Billing {
      aggregate Invoice {
        amount: int
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState  { for: Orders,  kind: state, use: primary }
  resource billingState { for: Billing, kind: state, use: primary }
  ui WebApp {}
  deployable webApp {
    platform: elixir
    contexts: [Orders, Billing]
    dataSources: [ordersState, billingState]
    ui: WebApp
    port: 4000
  }
}
`;

describe("F7d — Phoenix orchestrator rewire (system mode)", () => {
  it("dispatches the ash_domains config block through ashStyleAdapter.emitDi", async () => {
    const spy = vi.spyOn(ashStyleModule.ashStyleAdapter, "emitDi");
    try {
      const files = (await generateSystems(await parseValid(SYSTEM_SRC))).files;
      // The adapter was invoked at least once for the Phoenix
      // deployable.
      expect(spy).toHaveBeenCalled();
      // The dispatched output landed in config/config.exs.
      const configPath = [...files.keys()].find((k) => k.endsWith("/config/config.exs"));
      expect(configPath).toBeDefined();
      const content = files.get(configPath!)!;
      // Both context domains appear in the dispatched block.
      expect(content).toContain("ash_domains:");
      expect(content).toContain("WebApp.Orders");
      expect(content).toContain("WebApp.Billing");
      // Threaded through correctly — `config :web_app,` is the adapter's
      // first line (snake-app derived from the deployable name).
      expect(content).toContain("config :web_app,");
    } finally {
      spy.mockRestore();
    }
  });
});
