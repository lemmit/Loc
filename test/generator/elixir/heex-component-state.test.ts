// Component-local `state { … }` + component-level named `action` on Phoenix
// LiveView.
//
// A HEEx function component is a pure render function: it owns no process, so
// it can hold neither state nor a `handle_event` clause.  React gives
// `component C { state { n } action bump() }` a per-instance `useState`; the
// LiveView equivalent is to LIFT the state into the HOST page's assigns and
// HOIST the handler onto the host LiveView.  Every reference spells the one
// namespaced name (`<component>_<field>`) — the component's own template
// `@counter_n`, the host's `assign(:counter_n, …)`, the call site's
// `counter_n={@counter_n}` — so an intermediate component forwards it verbatim.
//
// Before this, only STORE-MUTATING component handlers hoisted: a component
// declaring its own state emitted `<.button phx-click="bump">` against a
// LiveView with zero matching clauses (a runtime `FunctionClauseError` on the
// first click) and never emitted the state field at all.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function build(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
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
}

const LIVE = "phoenix_app/lib/phoenix_app_web/live/home_live.ex";
const COMPONENTS = "phoenix_app/lib/phoenix_app_web/components/ui_components.ex";

const COUNTER = `
  component Counter(label: string) {
    state { n: int = 0 }
    action bump() { n := n + 1 }
    body: Stack { Text { label }, Text { n }, Button { "Bump", onClick: bump } }
  }
  page Home {
    route: "/"
    body: Counter(label: "Hits")
  }
`;

describe("HEEx component-local state + actions", () => {
  it("hoists a non-store component action into a real handle_event clause on the host", async () => {
    const files = await build(COUNTER);
    const live = files.get(LIVE);
    const comp = files.get(COMPONENTS);
    expect(live, "home_live.ex not emitted").toBeDefined();
    expect(comp, "ui_components.ex not emitted").toBeDefined();

    // The component still emits the click binding...
    expect(comp!).toContain('phx-click="bump"');
    // ...and still holds no clause of its own (it is a function component).
    expect(comp!).not.toContain("def handle_event");
    // The host LiveView carries the clause the binding dispatches to.  Without
    // it the click raises FunctionClauseError at runtime.
    expect(live!).toContain('def handle_event("bump"');
  });

  it("lifts the component's state into the host's assigns and seeds it in mount", async () => {
    const files = await build(COUNTER);
    const live = files.get(LIVE)!;
    // Seeded from the field's declared `= 0`, namespaced by component.
    expect(live).toContain("|> assign(:counter_n, 0)");
    // The hoisted handler reads/writes that same host assign.
    const clause = live.match(/def handle_event\("bump"[\s\S]*?\n {2}end/)?.[0] ?? "";
    expect(clause).toContain("assign(:counter_n, socket.assigns.counter_n + 1)");
    // The bare (un-namespaced) page-state spelling must NOT appear — it would
    // read an assign the page never seeds.
    expect(live).not.toMatch(/assign\(:n,/);
  });

  it("declares the lifted state as an attr and threads it back down at the call site", async () => {
    const files = await build(COUNTER);
    const comp = files.get(COMPONENTS)!;
    const live = files.get(LIVE)!;
    // Attr default = the field's own init, so the component never fails to
    // render if some future call path forgets to pass it.
    expect(comp).toContain("attr :counter_n, :integer, default: 0");
    // The component's template reads the attr...
    expect(comp).toContain("@counter_n");
    // ...and the host passes its assign down.
    expect(live).toContain("counter_n={@counter_n}");
  });

  it("forwards lifted state transitively through an intermediate component", async () => {
    const files = await build(`
      component Counter() {
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Text { n }, Button { "Bump", onClick: bump } }
      }
      component Wrapper() { body: Stack { Counter() } }
      page Home { route: "/" body: Wrapper() }
    `);
    const comp = files.get(COMPONENTS)!;
    const live = files.get(LIVE)!;
    // The intermediate declares the attr it can only forward, not own.
    const wrapper = comp.match(/def wrapper\(assigns\)[\s\S]*?\n {2}end/)?.[0] ?? "";
    expect(comp).toMatch(/attr :counter_n, :integer, default: 0\n {2}def wrapper/);
    expect(wrapper).toContain("counter_n={@counter_n}");
    // The host seeds it once and passes it to the intermediate.
    expect(live).toContain("|> assign(:counter_n, 0)");
    expect(live).toContain(
      "<PhoenixAppWeb.Components.UiComponents.wrapper counter_n={@counter_n} />",
    );
    expect(live).toContain('def handle_event("bump"');
  });

  it("namespaces per component, so two components can each declare `n`", async () => {
    const files = await build(`
      component Left() {
        state { n: int = 1 }
        action incLeft() { n := n + 1 }
        body: Stack { Text { n }, Button { "L", onClick: incLeft } }
      }
      component Right() {
        state { n: int = 2 }
        action incRight() { n := n + 1 }
        body: Stack { Text { n }, Button { "R", onClick: incRight } }
      }
      page Home { route: "/" body: Stack { Left(), Right() } }
    `);
    const live = files.get(LIVE)!;
    expect(live).toContain("|> assign(:left_n, 1)");
    expect(live).toContain("|> assign(:right_n, 2)");
    expect(live).toContain('def handle_event("inc_left"');
    expect(live).toContain('def handle_event("inc_right"');
  });

  it("binds a controlled input in a component to the lifted assign, not a bare one", async () => {
    // `bind:` hoists its own write-back clause, which runs on the HOST — so the
    // assign it writes, the form field name and the `phx-change` payload key
    // must all spell the namespaced name the template reads.
    const files = await build(`
      component NoteBox() {
        state { notes: string = "" }
        body: Stack { MultilineField { "Notes", bind: notes } }
      }
      page Home { route: "/" body: NoteBox() }
    `);
    const comp = files.get(COMPONENTS)!;
    const live = files.get(LIVE)!;
    expect(comp).toContain('name="note_box_notes"');
    expect(comp).toContain("value={@note_box_notes}");
    expect(comp).toContain('phx-change="update_note_box_notes"');
    // The write-back clause is hoisted onto the host and writes the same assign
    // the host seeded.
    expect(live).toContain('|> assign(:note_box_notes, "")');
    expect(live).toContain(
      'def handle_event("update_note_box_notes", %{"note_box_notes" => value}',
    );
    expect(live).toContain("assign(socket, :note_box_notes, value)");
  });

  it("keeps a page's own state assign un-namespaced (no churn for page bodies)", async () => {
    const files = await build(`
      page Home {
        route: "/"
        state { n: int = 3 }
        action bump() { n := n + 1 }
        body: Stack { Text { n }, Button { "Bump", onClick: bump } }
      }
    `);
    const live = files.get(LIVE)!;
    expect(live).toContain("|> assign(:n, 3)");
    expect(live).toContain("assign(:n, socket.assigns.n + 1)");
  });
});

describe("HEEx component-state — honestly gated slices", () => {
  it("fails at codegen when a stateful component is rendered more than once", async () => {
    // One host assign per component NAME cannot serve two live instances: React
    // gives each `<Counter/>` its own `useState`, and two lifted counters would
    // move together.  Fail loudly rather than ship a shared cell.
    await expect(
      build(`
        component Counter() {
          state { n: int = 0 }
          action bump() { n := n + 1 }
          body: Stack { Text { n }, Button { "Bump", onClick: bump } }
        }
        page Home { route: "/" body: Stack { Counter(), Counter() } }
      `),
    ).rejects.toThrow(/renders component 'Counter' 2 times.*declares `state`/s);
  });

  it("fails at codegen when two hoisted handlers collide on one event name", async () => {
    // A LiveView dispatches every `phx-click` by name, so two different `bump`
    // bodies on one page mean one of the buttons silently does the other's work.
    await expect(
      build(`
        component A() {
          state { n: int = 0 }
          action bump() { n := n + 1 }
          body: Button { "A", onClick: bump }
        }
        component B() {
          state { m: int = 0 }
          action bump() { m := m + 2 }
          body: Button { "B", onClick: bump }
        }
        page Home { route: "/" body: Stack { A(), B() } }
      `),
    ).rejects.toThrow(/two different `bump` handlers/);
  });

  it("does not gate a stateless component rendered twice", async () => {
    const files = await build(`
      component Label(text: string) { body: Text { text } }
      page Home { route: "/" body: Stack { Label(text: "a"), Label(text: "b") } }
    `);
    expect(files.get(LIVE)).toBeDefined();
  });
});
