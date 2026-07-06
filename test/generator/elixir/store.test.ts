import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView `store` projection (named-actions-and-stores.md §3, Stage 5).
//
// A `store Cart { state {…} action … }` on a `platform: elixir`
// (phoenixLiveView) deployable now emits — previously hard-gated by
// `loom.store-on-liveview-unsupported`:
//
//   - a per-store module `lib/<app>_web/stores/<snake>.ex`
//     (`defstruct …` + one pure `def <action>(%__MODULE__{} = state, …)`);
//   - per-using-page wiring: an `alias …Stores.<Pascal>`, a `mount/3`
//     `assign(:<snake>, %<Pascal>{})`, position-aware field reads
//     (`@cart.count` template / `socket.assigns.cart.count` handler), and
//     a `update(socket, :cart, …)` for a page action calling a store action.
//
// These tests generate the full system to a file map (the same
// `generateSystems(model)` helper the rest of the elixir generator suite uses)
// and assert on the emitted `.ex` content — the lowest altitude that catches a
// malformed Elixir / unaliased struct / wrong-arity `update` / leaked flat
// assign.
// ---------------------------------------------------------------------------

/** Parse + validate `source` to a Langium `Model` (validation enabled, throws
 *  on errors) — the mirror of phoenix-live-view-pipeline.test.ts::buildFixture. */
async function buildFixture(source: string): Promise<Model> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-store-"));
  const file = path.join(dir, "store.ddd");
  fs.writeFileSync(file, source);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `Validation errors in fixture:\n${errors.map((e) => `  ${e.message}`).join("\n")}`,
    );
  }
  return doc.parseResult.value as Model;
}

/** Generate `source` to a file map. */
async function gen(source: string): Promise<Map<string, string>> {
  const model = await buildFixture(source);
  return generateSystems(model).files;
}

/** IR-validation diagnostic codes for a parsed-clean `source` (validation here
 *  is the Langium-level pass; IR validation is a separate, later pass). */
async function irCodes(source: string): Promise<string[]> {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

// The canonical store-showcase source — one store, a page reading it + calling
// a store action from a page action, and a component adding to the store.
// Deployable slug `app` → project dir `app/`, web module `AppWeb`.
const SHOWCASE = `
system Demo {
  subdomain S {
    context C {
      aggregate Order with crudish { customerId: string }
      repository Orders for Order { }
    }
  }
  api A from S
  ui Web {
    api C: A
    store Cart {
      state {
        lines: string[]
        count: int = 0
      }
      action add(sku: string) {
        lines += sku
        count += 1
      }
      action clear() {
        lines := [ ]
        count := 0
      }
    }
    component CartSummary() {
      action addOne() { Cart.add("SKU-1") }
      body: Stack {
        Heading { "Items in cart", level: 3 },
        Button { "Add item", onClick: addOne }
      }
    }
    page CartPage {
      route: "/cart"
      state { confirming: bool = false }
      action discard() { Cart.clear() }
      body: Stack {
        Heading { "Your cart", level: 1 },
        Heading { Cart.count, level: 2 },
        CartSummary(),
        Button { "Discard", onClick: discard }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: Web { C: app }
    port: 4000
  }
}`;

const STORE_PATH = "app/lib/app_web/stores/cart.ex";
const CART_PAGE_PATH = "app/lib/app_web/live/cart_page_live.ex";

describe("store/elixir — per-store module emission", () => {
  it("emits lib/<app>_web/stores/cart.ex with the <App>Web.Stores.Cart module + defstruct", async () => {
    const files = await gen(SHOWCASE);
    const store = files.get(STORE_PATH);
    expect(store, `${STORE_PATH} is emitted`).toBeDefined();
    expect(store!).toContain("defmodule AppWeb.Stores.Cart do");
    // defstruct carries every state field with its declared default.
    expect(store!).toContain("defstruct lines: [], count: 0");
  });

  it("emits one pure `def <action>(%__MODULE__{} = state, …)` per store action with struct-update bodies", async () => {
    const store = (await gen(SHOWCASE)).get(STORE_PATH)!;
    // add/1 takes the param; both rebind `state` and return the struct.
    expect(store).toContain("def add(%__MODULE__{} = state, sku) do");
    expect(store).toContain("state = %{state | lines: state.lines ++ [sku]}");
    expect(store).toContain("%{state | count: state.count + 1}");
    // clear/0 (no params) — multi-write body.
    expect(store).toContain("def clear(%__MODULE__{} = state) do");
    expect(store).toContain("%{state | lines: []}");
    expect(store).toContain("%{state | count: 0}");
  });
});

describe("store/elixir — page wiring", () => {
  it("seeds the alias + mount assign(:cart, %Cart{}) alongside the page-local state assign", async () => {
    const page = (await gen(SHOWCASE)).get(CART_PAGE_PATH)!;
    expect(page).toContain("alias AppWeb.Stores.Cart");
    // page-local `confirming` AND the store assign, both in mount/3.
    expect(page).toContain("|> assign(:confirming, false)");
    expect(page).toContain("|> assign(:cart, %Cart{})");
  });

  it("reads a store field in template position as @cart.count", async () => {
    const page = (await gen(SHOWCASE)).get(CART_PAGE_PATH)!;
    expect(page).toContain("@cart.count");
    // Never the flat SPA-style @count for a store field (that would collide).
    expect(page).not.toMatch(/<%=\s*@count\s*%>/);
  });

  it("renders a 0-arg page-action store call as update(:cart, &Cart.clear/1)", async () => {
    const page = (await gen(SHOWCASE)).get(CART_PAGE_PATH)!;
    expect(page).toContain('def handle_event("discard"');
    expect(page).toContain("|> update(:cart, &Cart.clear/1)");
  });

  it('renders a with-args store call (hoisted from a component) as update(:cart, fn c -> Cart.add(c, "SKU-1") end)', async () => {
    // The component's `addOne() { Cart.add("SKU-1") }` is hoisted to the host
    // page (component function components hold no socket).
    const page = (await gen(SHOWCASE)).get(CART_PAGE_PATH)!;
    expect(page).toContain('def handle_event("add_one"');
    expect(page).toContain('|> update(:cart, fn c -> Cart.add(c, "SKU-1") end)');
  });

  it("does NOT seed the alias/assign on a page that never reads the store", async () => {
    // A page that touches no store must not carry a dangling `alias`/`%Cart{}`
    // assign — the per-page wiring is gated on actually using the store.
    const WITH_HOME = `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } repository Orders for Order { } } }
  api A from S
  ui Web {
    api C: A
    store Cart { state { count: int = 0 } action bump() { count += 1 } }
    page Uses { route: "/c" body: Heading { Cart.count, level: 1 } }
    page Home { route: "/" body: Heading { "hi", level: 1 } }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: Web { C: app }
    port: 4000
  }
}`;
    const files = await gen(WITH_HOME);
    const home = files.get("app/lib/app_web/live/home_live.ex");
    expect(home, "home_live.ex is emitted").toBeDefined();
    expect(home!).not.toContain("alias AppWeb.Stores.Cart");
    expect(home!).not.toContain("%Cart{}");
    // …while the using page DOES.
    const uses = files.get("app/lib/app_web/live/uses_live.ex")!;
    expect(uses).toContain("alias AppWeb.Stores.Cart");
    expect(uses).toContain("|> assign(:cart, %Cart{})");
  });
});

describe("store/elixir — component path", () => {
  it("hoists a store-mutating component handler to the host page; the component stays a stateless function component", async () => {
    const files = await gen(SHOWCASE);
    const comp = files.get("app/lib/app_web/components/ui_components.ex");
    expect(comp, "ui_components.ex is emitted").toBeDefined();
    // The component renders the button with phx-click but holds NO handle_event
    // (it's a function component) — the handler lives on the host page.
    expect(comp!).toContain("def cart_summary(assigns) do");
    expect(comp!).toContain('phx-click="add_one"');
    expect(comp!).not.toContain("def handle_event");
    // …and the host page DOES carry the hoisted handler.
    const page = files.get(CART_PAGE_PATH)!;
    expect(page).toContain('def handle_event("add_one"');
  });
});

describe("store/elixir — adversarial / divergence probes", () => {
  // A store with a money field (no init), an unread field, and a page that has
  // its OWN `state { count }` colliding by name with `Cart.count`.
  const PROBE = `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } repository Orders for Order { } } }
  api A from S
  ui Web {
    api C: A
    store Cart {
      state {
        lines: string[]
        count: int = 0
        total: money
        unused: bool = false
      }
      action add(sku: string) { lines += sku  count += 1 }
      action clear() { lines := [ ]  count := 0 }
    }
    page P {
      route: "/p"
      state { count: int = 0 }
      action discard() { Cart.clear() }
      body: Stack {
        Heading { Cart.count, level: 1 },
        Heading { count, level: 2 }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: Web { C: app }
    port: 4000
  }
}`;

  it('a money store field defaults to Decimal.new("0") in the defstruct', async () => {
    const store = (await gen(PROBE)).get(STORE_PATH)!;
    expect(store).toContain('total: Decimal.new("0")');
  });

  it("a store field no page reads still rides the defstruct (struct carries it)", async () => {
    const store = (await gen(PROBE)).get(STORE_PATH)!;
    expect(store).toContain("unused: false");
  });

  it("a page-local `count` and a store `Cart.count` do NOT collide — @count vs @cart.count", async () => {
    const page = (await gen(PROBE)).get("app/lib/app_web/live/p_live.ex")!;
    // Both assigns seeded distinctly.
    expect(page).toContain("|> assign(:count, 0)");
    expect(page).toContain("|> assign(:cart, %Cart{})");
    // Distinct reads in the template — the store namespaces through the struct.
    expect(page).toContain("@cart.count");
    expect(page).toMatch(/<%=\s*@count\s*%>/);
  });

  it("splits a store read by position — @cart.count (template) vs socket.assigns.cart.count (handler)", async () => {
    const POS = `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } repository Orders for Order { } } }
  api A from S
  ui Web {
    api C: A
    store Cart {
      state { count: int = 0 }
      action bump() { count += 1 }
    }
    page P {
      route: "/p"
      action discard() {
        let n = Cart.count
        toast("count")
      }
      body: Stack {
        Heading { Cart.count, level: 1 },
        Button { "Go", onClick: discard }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: Web { C: app }
    port: 4000
  }
}`;
    const page = (await gen(POS)).get("app/lib/app_web/live/p_live.ex")!;
    // Template read.
    expect(page).toContain("@cart.count");
    // Handler read — the page action body lands in handle_event.
    expect(page).toContain("socket.assigns.cart.count");
  });

  it("renders a same-store action calling a sibling action as an in-module call threading the struct", async () => {
    const CHAIN = `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } repository Orders for Order { } } }
  api A from S
  ui Web {
    api C: A
    store Cart {
      state { lines: string[]  count: int = 0 }
      action add(sku: string) { lines += sku  bumpCount() }
      action bumpCount() { count += 1 }
    }
    page P {
      route: "/p"
      action go() { Cart.add("X") }
      body: Heading { Cart.count, level: 1 }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: Web { C: app }
    port: 4000
  }
}`;
    const store = (await gen(CHAIN)).get(STORE_PATH)!;
    // add/1's body ends with a sibling call returning the struct.
    expect(store).toContain("bump_count(state)");
    // single-statement bumpCount collapses to the inline `do:` form.
    expect(store).toContain(
      "def bump_count(%__MODULE__{} = state), do: %{state | count: state.count + 1}",
    );
  });
});

describe("store/elixir — validator (IR level)", () => {
  const wrapElixir = (body: string) => `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } repository Orders for Order { } } }
  api A from S
  ui Web {
    api C: A
    ${body}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: Web { C: app }
    port: 4000
  }
}`;

  // SPA twin — same body on a react deployable that targets a separate backend.
  const wrapReact = (body: string) => `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } repository Orders for Order { } } }
  api A from S
  ui Web {
    api C: A
    ${body}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 3000
  }
  deployable web {
    platform: react
    targets: api
    ui: Web { C: api }
    port: 3001
  }
}`;

  it("(a) a memory store on a phoenixLiveView mount is CLEAN — no loom.store-*-unsupported", async () => {
    const codes = await irCodes(
      wrapElixir(`
      store Cart { state { count: int = 0 } action bump() { count += 1 } }
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }`),
    );
    expect(codes).not.toContain("loom.store-on-liveview-unsupported");
    expect(codes).not.toContain("loom.store-cross-store-on-liveview-unsupported");
  });

  it("(b) a store action calling a DIFFERENT store's action on LiveView fires loom.store-cross-store-on-liveview-unsupported", async () => {
    const codes = await irCodes(
      wrapElixir(`
      store B { state { y: int = 0 } action g() { D.h() } }
      store D { state { z: int = 0 } action h() { z := 1 } }
      page P { route: "/p" body: Heading { B.y, level: 1 } }`),
    );
    expect(codes).toContain("loom.store-cross-store-on-liveview-unsupported");
  });

  it("(c) same-store action→action composition on LiveView is CLEAN", async () => {
    const codes = await irCodes(
      wrapElixir(`
      store B { state { y: int = 0 } action g() { reset() } action reset() { y := 0 } }
      page P { route: "/p" body: Heading { B.y, level: 1 } }`),
    );
    expect(codes).not.toContain("loom.store-cross-store-on-liveview-unsupported");
  });

  it("(d) the SAME cross-store ddd on a react (SPA) mount is CLEAN — the gate is phoenixLiveView-scoped", async () => {
    const codes = await irCodes(
      wrapReact(`
      store B { state { y: int = 0 } action g() { D.h() } }
      store D { state { z: int = 0 } action h() { z := 1 } }
      page P { route: "/p" body: Heading { B.y, level: 1 } }`),
    );
    expect(codes).not.toContain("loom.store-cross-store-on-liveview-unsupported");
  });
});
