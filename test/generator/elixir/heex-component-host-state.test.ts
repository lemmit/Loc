import { describe, expect, it } from "vitest";
import { HEEX_HOST_STATE_PRIMITIVES } from "../../../src/ir/util/heex-component-host-state.js";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// `G2646-open-heex-in-component-degradation` — the ledger calls it a silent
// DEGRADATION; measured on generated output it is a CRASH the compile gate
// cannot see.
//
// A HEEx function component is a pure render function with no process of its
// own.  #2646 lifted a component's `state { … }` and named `action`s into the
// host page's LiveView (`ComponentActionInfo.state` / `.handlers`) and stopped
// there — the walker's `formBindings` / `queryBindings` / `uploadBindings` /
// `tableControls` accumulators were never extended.  So the component emits its
// markup and the host LiveView gets nothing:
//
//   defmodule DemoWeb.Components.UiComponents do
//     def new_customer(assigns) do
//       ~H"""
//       <.simple_form for={@form} phx-submit="save_customer">
//       ...
//   defmodule DemoWeb.HomeLive do
//     def mount(_params, _session, socket), do: {:ok, socket}   # no @form
//     # ...and no handle_event("save_customer", …)
//
// That passes `mix compile --warnings-as-errors` and then raises on page load
// for the assign that was never made.  Until the four accumulators hoist the way
// state and actions already do, the gate refuses it at compile time — a message
// the author reads beats a failure they meet in the running app.
//
// The set is EMPIRICAL, one generated case per primitive (see the module
// header); this suite is what keeps it that way.
// ---------------------------------------------------------------------------

const CASES: Record<string, string> = {
  CreateForm: "CreateForm { of: Customer }",
  OperationForm: "OperationForm { of: Customer, op: rename }",
  WorkflowForm: "WorkflowForm { runs: Signup }",
  DestroyForm: "DestroyForm { of: Customer, id: cid }",
  QueryView: "QueryView { of: Customer }",
  Table: "Table { of: Customer, sortable: true }",
  FileUpload: "FileUpload { bind: pic }",
  Chart: 'Chart { kind: "bar", of: C.ByName, x: r => r.name, y: r => r.n }',
};

const src = (componentBody: string, framework = "elixir"): string => `
system Demo {
  subdomain S {
    context C {
      aggregate Customer with crudish {
        name: string
        avatar: File?
        operation rename(n: string) { name := n }
      }
      repository Customers for Customer { }
      projection ByName {
        name: string
        n: int
        from Customer as c
        group by c.name
        select name = c.name, n = count()
      }
      workflow Signup { create(n: string) { let c = Customer.create({ name: n }) } }
    }
  }
  api CApi from S
  ui Web {
    api C: CApi
    component Inner() {
      state { shown: bool = false  cid: Customer id?  pic: File }
      body: ${componentBody}
    }
    page Home { route: "/" body: Inner() }
  }
  storage primary { type: postgres }
  storage blobs { type: localDisk }
  resource cState { for: C, kind: state, use: primary }
  resource cBlobs { for: C, kind: objectStore, use: blobs }
  deployable phoenixApp {
    platform: ${framework} contexts: [C] dataSources: [cState, cBlobs] serves: CApi
    ui: Web { C: phoenixApp } port: 4000
  }
}
`;

async function errorsFor(body: string, framework?: string): Promise<string> {
  try {
    await generateSystemFiles(src(body, framework));
    return "";
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

describe("a host-state primitive inside a HEEx component is refused, not silently broken", () => {
  for (const [primitive, body] of Object.entries(CASES)) {
    it(`${primitive} in a component raises loom.heex-component-host-state-unsupported`, async () => {
      const msg = await errorsFor(body);
      expect(msg).toContain("loom.heex-component-host-state-unsupported");
      expect(msg).toContain(`component 'Inner' uses '${primitive}'`);
      // The message must name the escape hatch, not just the refusal.
      expect(msg).toContain(`Move '${primitive}' into the page body`);
    });
  }

  it("the gate's set is exactly the documented one — a new member needs its own case", () => {
    // Keeps the empirical set and the suite that proves it in lockstep: adding a
    // primitive to the set without a generated case here (or vice versa) fails.
    expect([...HEEX_HOST_STATE_PRIMITIVES].sort()).toEqual(Object.keys(CASES).sort());
  });

  it("leaves a display-only component alone", async () => {
    // The gate must not refuse what already works: layout, display, `state`
    // and `action`s inside a component all hoist correctly (#2646).
    expect(await errorsFor('Stack { Text { "hi" }, Text { shown } }')).toBe("");
  });

  it("does not fire on a non-LiveView frontend, where the same body renders", async () => {
    // The hoisting gap is LiveView's, not the DSL's — the same component is
    // perfectly renderable on a JSX target, so the gate is scoped to the
    // framework that cannot render it.
    const files = await generateSystemFiles(`
      system Demo2 {
        subdomain S { context C { aggregate Customer with crudish { name: string } repository Customers for Customer { } } }
        api CApi from S
        ui Web {
          api C: CApi
          component Inner() { body: CreateForm { of: Customer } }
          page Home { route: "/" body: Inner() }
        }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }
        deployable api { platform: node contexts: [C] dataSources: [cState] serves: CApi port: 4000 }
        deployable web { platform: react targets: api ui: Web { C: api } port: 3000 }
      }
    `);
    expect([...files.keys()].some((k) => k.endsWith("/pages/home.tsx"))).toBe(true);
  });
});
