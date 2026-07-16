// `store` lowering + IR-validation (named-actions-and-stores.md §3, Stage 5).
//
// Lowering: a `store Cart { … }` lands on `UiIR.stores` (always `lifetime:
// "memory"`), a page/component reading `Cart.lines` lowers the ref to
// `refKind: "store-field"` (carrying `storeName`), and a `Cart.clear()` call
// lowers to a `store-action` CallStmt (carrying the resolved `store`) — never
// an `unknown`/`private-operation`.  Stores resolve identically from a page
// and a component body.
//
// Validation negatives — the four `loom.store-*` gates.  Each is paired with a
// LEGAL counter-case that must stay clean (a view effect on a page, a store's
// own state write, an acyclic page→store→store chain, a React-mounted store).
// `loom.store-lifetime-unsupported` has no grammar surface (the persist/sync
// ladder was kept out — see the `Store` rule); it is a defensive guard against
// programmatic IR construction, exercised by building the IR directly.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR, StmtIR, StoreIR } from "../../src/ir/types/loom-ir.js";
import { validateStores } from "../../src/ir/validate/checks/store-checks.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (ui: string, webPlatform = "react") => `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } } }
  api A from S
  ui Web {
    api C: A
    ${ui}
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
    platform: ${webPlatform}
    targets: api
    ui: Web { C: api }
    port: 3001
  }
}`;

async function ir(ui: string, webPlatform = "react") {
  const { model, errors } = await parseString(wrap(ui, webPlatform));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return enrichLoomModel(lowerModel(model));
}

/** IR-validation diagnostic codes for a `ui` body. */
async function codes(ui: string, webPlatform = "react"): Promise<string[]> {
  return validateLoomModel(await ir(ui, webPlatform)).map((d) => d.code);
}

const STORE = `
  store Cart {
    state {
      lines: string[]
      count: int = 0
    }
    action add(sku: string) { lines += sku  count += 1 }
    action clear() { lines := [ ]  count := 0 }
  }`;

describe("store — lowering", () => {
  it("lowers to a `StoreIR` on `UiIR.stores` with state + actions, lifetime memory", async () => {
    const ui = (await ir(STORE)).systems[0]!.uis[0]!;
    expect(ui.stores).toHaveLength(1);
    const cart = ui.stores[0]!;
    expect(cart.name).toBe("Cart");
    expect(cart.lifetime).toBe("memory");
    expect(cart.state.map((f) => f.name)).toEqual(["lines", "count"]);
    expect(cart.state[0]!.type).toEqual({
      kind: "array",
      element: { kind: "primitive", name: "string" },
    });
    expect(cart.actions.map((a) => a.name)).toEqual(["add", "clear"]);
    expect(cart.actions[0]!.params.map((p) => p.name)).toEqual(["sku"]);
  });

  it("lowers a page `Cart.lines` read to a `store-field` ref carrying the store name", async () => {
    const ui = (
      await ir(`
      ${STORE}
      page P {
        route: "/p"
        body: For { each: Cart.lines, line => Card { line } }
      }`)
    ).systems[0]!.uis[0]!;
    const page = ui.pages.find((p) => p.name === "P")!;
    // The `For { each: Cart.lines }` source carries the store-field ref.
    type RefIR = Extract<ExprIR, { kind: "ref" }>;
    const refs: RefIR[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const node = n as RefIR;
      if (node.kind === "ref" && node.refKind === "store-field") {
        refs.push(node);
      }
      for (const v of Object.values(n as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };
    walk(page.body);
    expect(refs.length).toBeGreaterThan(0);
    const linesRef = refs.find((r) => r.name === "lines")!;
    expect(linesRef.refKind).toBe("store-field");
    expect(linesRef.storeName).toBe("Cart");
  });

  it("lowers a page action `Cart.clear()` to a `store-action` call carrying the store", async () => {
    const ui = (
      await ir(`
      ${STORE}
      page P {
        route: "/p"
        action discard() { Cart.clear() }
        body: Button { "x", onClick: discard }
      }`)
    ).systems[0]!.uis[0]!;
    const page = ui.pages.find((p) => p.name === "P")!;
    const stmt = page.actions.find((a) => a.name === "discard")!.body[0] as Extract<
      StmtIR,
      { kind: "call" }
    >;
    expect(stmt.kind).toBe("call");
    // NOT private-operation / unknown — a resolved store-action call.
    expect(stmt.target).toBe("store-action");
    expect(stmt.name).toBe("clear");
    expect(stmt.store).toBe("Cart");
  });

  it("lowers a bare `onClick: Cart.clear` to a store `action-ref`, not a store-field ref (M-T6.15)", async () => {
    // Regression: a bare store-action reference in handler position used to be
    // mis-lowered as a store-FIELD ref (no `()` ⇒ assumed a field), so every
    // frontend silently dropped the handler.  It must be a store `action-ref`.
    const ui = (
      await ir(`
      ${STORE}
      page P {
        route: "/p"
        body: Button { "Clear", onClick: Cart.clear }
      }`)
    ).systems[0]!.uis[0]!;
    const page = ui.pages.find((p) => p.name === "P")!;
    let found: Extract<ExprIR, { kind: "action-ref" }> | undefined;
    const walk = (e: ExprIR | undefined): void => {
      if (!e || typeof e !== "object") return;
      if (e.kind === "action-ref" && e.storeName) found = e;
      for (const v of Object.values(e as Record<string, unknown>)) {
        if (Array.isArray(v)) for (const el of v) walk(el as ExprIR);
        else if (v && typeof v === "object" && "kind" in (v as object)) walk(v as ExprIR);
      }
    };
    walk(page.body);
    expect(found).toBeDefined();
    expect(found!.actionName).toBe("clear");
    expect(found!.storeName).toBe("Cart");
  });

  it("resolves dotted store refs from BOTH a page and a component body", async () => {
    const ui = (
      await ir(`
      ${STORE}
      component CartSummary() {
        action addOne() { Cart.add("SKU-1") }
        body: Heading { Cart.count, level: 3 }
      }
      page P {
        route: "/p"
        action discard() { Cart.clear() }
        body: Stack { CartSummary(), Heading { Cart.count, level: 1 } }
      }`)
    ).systems[0]!.uis[0]!;
    // Component action calls a store action.
    const comp = ui.components.find((c) => c.name === "CartSummary")!;
    const compCall = comp.actions[0]!.body[0] as Extract<StmtIR, { kind: "call" }>;
    expect(compCall.target).toBe("store-action");
    expect(compCall.store).toBe("Cart");
    // Page action calls a store action.
    const page = ui.pages.find((p) => p.name === "P")!;
    const pageCall = page.actions[0]!.body[0] as Extract<StmtIR, { kind: "call" }>;
    expect(pageCall.target).toBe("store-action");
    expect(pageCall.store).toBe("Cart");
  });
});

describe("store — validation negatives", () => {
  it("loom.store-action-view-effect fires for navigate/toast in a store action; a page action is legal", async () => {
    expect(
      await codes(`
      store Cart { state { count: int = 0 } action go() { navigate("/x") } }
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }`),
    ).toContain("loom.store-action-view-effect");

    expect(
      await codes(`
      store Cart { state { count: int = 0 } action go() { toast("hi") } }
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }`),
    ).toContain("loom.store-action-view-effect");

    // A PAGE action calling navigate is legal — the page owns navigation.
    expect(
      await codes(`
      store Cart { state { count: int = 0 } action bump() { count += 1 } }
      page P { route: "/p" action go() { navigate("/x") } body: Heading { Cart.count, level: 1 } }`),
    ).not.toContain("loom.store-action-view-effect");
  });

  it("loom.store-state-inline-write fires for a page/component write; a store's own write + a read are legal", async () => {
    // Page action writing store state inline → fires.
    expect(
      await codes(`
      store Cart { state { count: int = 0 } action bump() { count += 1 } }
      page P { route: "/p" action bad() { Cart.count := 5 } body: Heading { Cart.count, level: 1 } }`),
    ).toContain("loom.store-state-inline-write");

    // Component action writing store state inline → fires.
    expect(
      await codes(`
      store Cart { state { count: int = 0 } action bump() { count += 1 } }
      component W() { action bad() { Cart.count := 5 } body: Heading { Cart.count, level: 3 } }
      page P { route: "/p" body: Stack { W() } }`),
    ).toContain("loom.store-state-inline-write");

    // A STORE's own action writing its own state → legal (the store owns it).
    expect(
      await codes(`
      store Cart { state { count: int = 0 } action bump() { count := 5 } }
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }`),
    ).not.toContain("loom.store-state-inline-write");

    // A page READING store state → legal.
    expect(
      await codes(`
      store Cart { state { count: int = 0 } action bump() { count += 1 } }
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }`),
    ).not.toContain("loom.store-state-inline-write");
  });

  it("a store on a phoenixLiveView mount is now SUPPORTED (gate lifted) — no store diagnostic fires", async () => {
    // A `platform: elixir` deployable hosting the ui directly (`ui: Web`)
    // lowers the mounted ui's framework to phoenixLiveView.  The HEEx target
    // gained the store-module + per-page-assign projection, so the old
    // `loom.store-on-liveview-unsupported` gate was lifted — a same-store
    // store on LiveView is clean.
    const liveview = `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } } }
  api A from S
  ui Web {
    api C: A
    store Cart { state { count: int = 0 } action bump() { count += 1 } }
    page P { route: "/p" body: Heading { Cart.count, level: 1 } }
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
    const { model, errors } = await parseString(liveview);
    if (errors.length) throw new Error(errors.join("\n"));
    const liveCodes = validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
    expect(liveCodes).not.toContain("loom.store-on-liveview-unsupported");
    expect(liveCodes).not.toContain("loom.store-cross-store-on-liveview-unsupported");

    // The SAME ui on each SPA deployable is clean too.
    for (const fw of ["react", "vue", "svelte", "angular"]) {
      expect(
        await codes(
          `
      store Cart { state { count: int = 0 } action bump() { count += 1 } }
      page P { route: "/p" body: Heading { Cart.count, level: 1 } }`,
          fw,
        ),
      ).not.toContain("loom.store-on-liveview-unsupported");
    }
  });

  it("loom.store-cross-store-on-liveview-unsupported fires for a cross-store action call on LiveView; same-store is clean", async () => {
    // On phoenixLiveView each store is its own per-page assign, so a store
    // action calling a DIFFERENT store's action has no handle to the sibling
    // struct — gated.  (A → A self-call is acyclic-rejected separately; B → C
    // here is acyclic, so only the cross-store gate fires.)
    const mk = (body: string) => `
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } } }
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
    const codesOf = async (body: string) => {
      const { model, errors } = await parseString(mk(body));
      if (errors.length) throw new Error(errors.join("\n"));
      return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
    };
    expect(
      await codesOf(`
      store B { state { y: int = 0 } action g() { D.h() } }
      store D { state { z: int = 0 } action h() { z := 1 } }
      page P { route: "/p" body: Heading { B.y, level: 1 } }`),
    ).toContain("loom.store-cross-store-on-liveview-unsupported");

    // Same-store action→action composition is fine.
    expect(
      await codesOf(`
      store B { state { y: int = 0 } action g() { reset() } action reset() { y := 0 } }
      page P { route: "/p" body: Heading { B.y, level: 1 } }`),
    ).not.toContain("loom.store-cross-store-on-liveview-unsupported");
  });

  it("a store on a Feliz-hosted ui is clean — stores fold into the Elmish Model (M-T6.15)", async () => {
    // Stores now compose into the single-program Feliz MVU (each field → a
    // namespaced Model field, each action → a Msg case), so the former
    // `loom.feliz-store-unsupported` gate is gone; a store on `platform: feliz`
    // validates cleanly, same as React.
    expect(await codes(STORE, "feliz")).not.toContain("loom.feliz-store-unsupported");
    expect(await codes(STORE, "react")).not.toContain("loom.feliz-store-unsupported");
  });

  it("loom.feliz-async-effect-unsupported — supported shapes on a `:id` page are CLEAN (incl. multi-variant); only the routeless host gates (M-T6.15)", async () => {
    // The Feliz MVU renderer now handles the v1 `match await` shape (a 0-arg
    // instance op, one aggregate SUCCESS arm + `else`, on a `:id` detail page) as
    // a trigger→result projection.  Only the shapes it does NOT render yet gate.
    const asyncSystem = (plat: string, route: string, arms: string, op = "reserve()") => `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        operation reserve(): Order or OrderMissing {
          return OrderMissing { missingRef: customerId }
        }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page P${route.includes(":id") ? "(id: Order id)" : ""} {
      route: "${route}"
      state { draftName: string = "" }
      action reserveNow() {
        match await C.Order.${op} {
${arms}
        }
      }
      body: Heading { "P", level: 1 }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: ${plat} targets: api ui: Web { C: api } port: 3001 }
}`;
    const V1_ARMS =
      '          Order o => { draftName := o.customerId }\n          else    => { draftName := "unavailable" }';
    const codesOf = async (src: string): Promise<string[]> => {
      const { model, errors } = await parseString(src);
      if (errors.length) throw new Error(`unexpected errors:\n${errors.join("\n")}`);
      return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
    };
    const GATE = "loom.feliz-async-effect-unsupported";

    // Supported: the v1 shape on a `:id` detail page, Feliz-hosted → NO gate.
    expect(await codesOf(asyncSystem("feliz", "/orders/:id", V1_ARMS))).not.toContain(GATE);
    // React never gates regardless.
    expect(await codesOf(asyncSystem("react", "/orders/:id", V1_ARMS))).not.toContain(GATE);

    // A paramless page is NOT a Feliz-specific gate: it's invalid on EVERY
    // frontend (no record in scope), so the target-agnostic
    // `loom.instance-effect-needs-route-id` (M-T6.17) rejects it — the Feliz gate
    // does not double-fire.  (Both feliz and react hit the universal gate.)
    const UNIVERSAL = "loom.instance-effect-needs-route-id";
    expect(await codesOf(asyncSystem("feliz", "/p", V1_ARMS))).not.toContain(GATE);
    expect(await codesOf(asyncSystem("feliz", "/p", V1_ARMS))).toContain(UNIVERSAL);
    expect(await codesOf(asyncSystem("react", "/p", V1_ARMS))).toContain(UNIVERSAL);

    // Supported now (harder shapes): a genuine multi-variant union on a `:id`
    // detail page renders (the tagged-union decoder + error reification) → the
    // Feliz gate is gone.  (The example still names an error arm, so it may trip
    // the FRONTEND-AGNOSTIC `loom.unmapped-error-status`; that's a separate
    // concern — here we only assert the Feliz-specific gate lifted.)
    const multiArm =
      "          Order o        => { draftName := o.customerId }\n" +
      "          OrderMissing e => { draftName := e.missingRef }\n" +
      '          else           => { draftName := "x" }';
    expect(await codesOf(asyncSystem("feliz", "/orders/:id", multiArm))).not.toContain(GATE);

    // The ONE remaining Feliz-specific gate: a match-await hosted by a COMPONENT
    // (not a page).  The Feliz generator projects async effects only on pages, so
    // a component effect would silently drop — it stays Feliz-gated.  React
    // renders it (no gate).  (The component has a `:id`-routed host, so the
    // universal route-id check is satisfied — this isolates the component gate.)
    const compSys = (plat: string) => `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        operation reserve(): Order or OrderMissing { return OrderMissing { missingRef: customerId } }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    component Confirmer(order: Order) {
      state { note: string = "" }
      action go() {
        match await C.Order.reserve() {
          Order o => { note := o.customerId }
          else    => { note := "x" }
        }
      }
      body: Button { "Go", onClick: go }
    }
    page Detail(id: Order id) {
      route: "/orders/:id"
      body: Confirmer(order: C.Order.byId(id))
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: ${plat} targets: api ui: Web { C: api } port: 3001 }
}`;
    expect(await codesOf(compSys("feliz"))).toContain(GATE);
    expect(await codesOf(compSys("react"))).not.toContain(GATE);
  });

  it("loom.store-action-cycle fires for store→store→store; an acyclic chain is clean", async () => {
    expect(
      await codes(`
      store A { state { x: int = 0 } action f() { B.g() } }
      store B { state { y: int = 0 } action g() { A.f() } }
      page P { route: "/p" body: Heading { A.x, level: 1 } }`),
    ).toContain("loom.store-action-cycle");

    // page → A.f → B.g, B.g writes its own state (no edge back) → acyclic.
    expect(
      await codes(`
      store A { state { x: int = 0 } action f() { B.g() } }
      store B { state { y: int = 0 } action g() { y := 1 } }
      page P { route: "/p" action go() { A.f() } body: Heading { A.x, level: 1 } }`),
    ).not.toContain("loom.store-action-cycle");
  });

  it("a non-memory lifetime on an SPA store is SUPPORTED — no diagnostic (the blanket gate is retired)", () => {
    // The lifetime ladder now ships on the SPA frontends, so a `persistLocal`
    // store on a non-LiveView ui produces no diagnostic.
    const store: StoreIR = { name: "Cart", lifetime: "persistLocal", state: [], actions: [] };
    const diags: import("../../src/ir/validate/checks/diagnostic.js").LoomDiagnostic[] = [];
    validateStores(
      {
        systems: [
          {
            uis: [{ name: "Web", stores: [store], pages: [], components: [] }],
            deployables: [],
          },
        ],
      } as never,
      diags,
    );
    expect(diags.map((d) => d.code)).not.toContain("loom.store-lifetime-unsupported");
    expect(diags.map((d) => d.code)).not.toContain("loom.store-lifetime-liveview-unsupported");
  });

  it("loom.store-lifetime-liveview-unsupported fires for a non-memory store mounted by a LiveView deployable", () => {
    const store: StoreIR = { name: "Cart", lifetime: "url", state: [], actions: [] };
    const diags: import("../../src/ir/validate/checks/diagnostic.js").LoomDiagnostic[] = [];
    validateStores(
      {
        systems: [
          {
            uis: [
              {
                name: "Web",
                stores: [store],
                pages: [],
                components: [],
                framework: "phoenixLiveView",
              },
            ],
            deployables: [{ name: "web", uiName: "Web", uiFramework: "phoenixLiveView" }],
          },
        ],
      } as never,
      diags,
    );
    expect(diags.map((d) => d.code)).toContain("loom.store-lifetime-liveview-unsupported");
  });

  it("loom.store-url-field-unsupported fires for an array/entity field in a `persist: url` store", () => {
    const store: StoreIR = {
      name: "Filters",
      lifetime: "url",
      state: [
        { name: "tags", type: { kind: "array", element: { kind: "primitive", name: "string" } } },
      ] as never,
      actions: [],
    };
    const diags: import("../../src/ir/validate/checks/diagnostic.js").LoomDiagnostic[] = [];
    validateStores(
      {
        systems: [
          { uis: [{ name: "Web", stores: [store], pages: [], components: [] }], deployables: [] },
        ],
      } as never,
      diags,
    );
    expect(diags.map((d) => d.code)).toContain("loom.store-url-field-unsupported");
  });
});

describe("store — lifetime ladder (frontend-state-management.md §3.1)", () => {
  it("lowers `persist: local|session|url` onto the StoreIR.lifetime enum", async () => {
    const lower = async (life: string) =>
      (await ir(`store S ${life} { state { q: string = "" } }`)).systems[0]!.uis[0]!.stores[0]!
        .lifetime;
    expect(await lower("persist: local")).toBe("persistLocal");
    expect(await lower("persist: session")).toBe("persistSession");
    expect(await lower("persist: url")).toBe("url");
    expect(await lower("persist: memory")).toBe("memory");
    expect(await lower("")).toBe("memory"); // bare store = in-memory default
  });

  it("loom.store-lifetime-invalid — an unknown `persist:` value is rejected at the AST tier", async () => {
    const { errors } = await parseString(
      wrap(`store S persist: bogus { state { q: string = "" } }`),
    );
    expect(errors.some((e) => e.includes("unknown lifetime 'bogus'"))).toBe(true);
  });
});
