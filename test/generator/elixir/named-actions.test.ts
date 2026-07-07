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
        platform: elixir
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

  it("inlines a nullary sibling action's body at the call site (Fix 1, HEEx)", async () => {
    // LiveView can't call one `handle_event` clause from another, so a nullary
    // `a() { b() }` inlines b's body pipe-steps into a's clause — the socket
    // flows through b's effect with NO call to an undefined function.
    const src = await phoenixLive(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action a() { b() }
        action b() { n := n + 1 }
        body: Stack { Button { "A", onClick: a } }
      }
    `);
    // a's clause carries b's assign inline (not a `handle_event("b")` call).
    const clauseA = src.match(/def handle_event\("a"[\s\S]*?\n {2}end/)?.[0] ?? "";
    expect(clauseA).toContain("assign(:n");
    // No attempt to invoke b as a function/clause from within a.
    expect(clauseA).not.toMatch(/handle_event\("b"/);
    expect(clauseA).not.toMatch(/\bb\(/);
  });

  it("emits a pinned no-op marker (no undefined call) for a parameterised action→action call (HEEx parity gap)", async () => {
    // A parameterised callee can't be cleanly inlined without param rewriting,
    // so codegen emits a `tap(fn _ -> :ok end)` marker — NOT a call to an
    // undefined `set_label/…` function (which would be broken Elixir).
    const src = await phoenixLive(`
      page P {
        route: "/p"
        state { label: string = "" }
        action setLabel(v: string) { label := v }
        action go() { setLabel("hi") }
        body: Stack { Button { "Go", onClick: go } }
      }
    `);
    const clauseGo = src.match(/def handle_event\("go"[\s\S]*?\n {2}end/)?.[0] ?? "";
    expect(clauseGo).toContain("tap(fn _ -> :ok end)");
    expect(clauseGo).toContain("HEEx parity gap");
    // The marker is a COMMENT; there is no real call to `set_label(...)`.
    expect(clauseGo).not.toMatch(/^\s*\|>\s*set_label\(/m);
  });
});
