// HEEx parity pin — `match await op() { … }` (async-actions-and-effects.md
// Stage 2).  The four JS frontends render the awaited variant-match as a
// client-side async handler (await the mutation, reify the thrown error into the
// error variant, `switch` on the union tag).  LiveView's async boundary is
// server-side (`handle_event` → context call → `case` on the tagged tuple), a
// genuinely different topology, so it is a scoped follow-up (see the pinned
// decision in async-actions-and-effects.md §7 + the JS leaves).
//
// This test FREEZES the current, reviewed behavior: the HEEx walker emits a
// no-op parity-gap marker rather than silently miscompiling the awaited call.
// It fails if a future change starts emitting something else for the seam
// without a corresponding decision — the "pin" for the Phoenix gap.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

describe("HEEx `match await` (Stage 2) — reviewed parity gap", () => {
  it("emits a no-op parity-gap marker for an awaited variant-match, not a miscompile", async () => {
    const files = await generateSystemFiles(`
      error Failed { reason: string }
      system Demo {
        subdomain S { context C {
          aggregate Order { code: string
            operation placeOrder(): Order or Failed { return Failed { reason: code } }
          }
        } }
        api CApi from C
        ui Web {
          api C: CApi
          page P {
            route: "/p"
            state { message: string = "" }
            action submit() {
              match await C.Order.placeOrder() {
                Order o  => { message := o.code }
                Failed f => { message := f.reason }
              }
            }
            body: Stack { Button { "Go", onClick: submit } }
          }
        }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }
        deployable phoenixApp {
          platform: elixir { foundation: vanilla }
          contexts: [C]
          dataSources: [cState]
          serves: CApi
          ui: Web { C: phoenixApp }
          port: 4000
        }
      }
    `);
    const src = files.get("phoenix_app/lib/phoenix_app_web/live/p_live.ex");
    expect(src, "p_live.ex not emitted").toBeDefined();
    // The awaited variant-match is a reviewed HEEx parity gap: a no-op marker,
    // NOT a client-side `switch`/`await`/`mutateAsync` (which would be invalid
    // Elixir), and NOT a silent drop.
    expect(src!).toContain("match await: LiveView server-side async not yet emitted");
    expect(src!).not.toContain("mutateAsync");
    expect(src!).not.toContain("switch (");
  });
});
