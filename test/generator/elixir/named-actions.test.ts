// Named, typed page `action`s on Phoenix LiveView (named-actions-and-stores.md,
// Proposal A Stage 1).  A page-level `action next() { … }` hoists to a
// `handle_event("<name>", …)` clause on the host LiveView (mirroring the
// inline-lambda hoist), and a bare `onClick: next` reference renders as
// `phx-click="<name>"` — binding the named clause instead of an `event_N`
// gensym.  Component-level actions hoist to the host LiveView the same way —
// see heex-component-state.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function phoenixLive(uiBody: string): Promise<string> {
  const files = await generateSystemFiles(`
    system Demo {
      subdomain S { context C { aggregate Customer { name: string } } }
      api CApi from S
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

  it("inlines a PARAMETERISED sibling action, substituting the caller's arguments", async () => {
    // Elixir cannot introduce a binding mid-pipe, so the inline IS the
    // substitution: the callee's body renders with each parameter replaced by
    // the caller's already-rendered argument.  This used to emit a
    // `tap(fn _ -> :ok end)` marker — valid Elixir that silently did nothing.
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
    // The callee's write lands in the caller's clause with the argument bound.
    expect(clauseGo).toContain('assign(:label, ("hi"))');
    // No leftover no-op marker, and still no call to an undefined function.
    expect(clauseGo).not.toContain("tap(fn _ -> :ok end)");
    expect(clauseGo).not.toMatch(/^\s*\|>\s*set_label\(/m);
  });

  it("substitutes a parameter that is itself an expression over page state", async () => {
    const src = await phoenixLive(`
      page P {
        route: "/p"
        state { n: int = 0 }
        action addTo(delta: int) { n := n + delta }
        action twice() { addTo(2) }
        body: Stack { Button { "Go", onClick: twice } }
      }
    `);
    const clause = src.match(/def handle_event\("twice"[\s\S]*?\n {2}end/)?.[0] ?? "";
    expect(clause).toContain("assign(:n, socket.assigns.n + (2))");
  });
});
