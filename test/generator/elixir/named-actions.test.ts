// Named, typed page `action`s on Phoenix LiveView (named-actions-and-stores.md,
// Proposal A Stage 1).  A page-level `action next() { … }` hoists to a
// `handle_event("<name>", …)` clause on the host LiveView (mirroring the
// inline-lambda hoist), and a bare `onClick: next` reference renders as
// `phx-click="<name>"` — binding the named clause instead of an `event_N`
// gensym.  (Component-level actions, like component-level lambdas, do not
// hoist to the host LiveView — a pre-existing HEEx limitation.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function phoenixLive(uiBody: string): Promise<string> {
  const files = await generateSystemFiles(`
    system Demo {
      subdomain S { context C { aggregate Customer { name: string } } }
      api CApi from C
      ui Web {
        api C: CApi
        ${uiBody}
      }
      storage primary { type: postgres }
      resource cState { for: C, kind: state, use: primary }
      deployable phoenixApp {
        platform: elixir { foundation: ash }
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
  return src!;
}

describe("Phoenix named `action` handlers", () => {
  it("hoists a nullary page action into a handle_event clause and binds it by name", async () => {
    const src = await phoenixLive(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
    `);
    // The bare reference renders the declared event name, not an event_N gensym.
    expect(src).toContain('phx-click="bump"');
    expect(src).not.toContain('phx-click="event_');
    // A real handle_event clause is hoisted from the action body — the `:=`
    // write lowers to the LiveView assign pipe.
    expect(src).toContain('def handle_event("bump"');
    expect(src).toContain("assign(:n");
  });
});
