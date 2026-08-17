import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// User (non-`extern`) components — Feliz flavour (`feliz/component-emit.ts`).
//
// Until this shipped, a walked `component TierBadge(…) { body: … }` produced NO
// output on Feliz and every use site rendered `(* unknown layout component:
// TierBadge *)` — the declaration and its uses vanished together (the last two
// rows of the `KNOWN_DEGRADATIONS` ratchet in
// `test/generator/_walker/render-degradation.test.ts`).
//
// Feliz has no per-component FILE, so each component becomes an F# function of
// its props record, declared in a nested `Components` module (then `open`ed)
// AHEAD of the page views — F# is order-sensitive, and the module is what makes a
// name collision with an App.fs member (a wire record, `Model`, `Api`, a hoisted
// grid child) impossible rather than enumerated: Fable rejects two members of the
// same name in one module.  The props record is what keeps ONE call form for both
// flavours — the extern seam's `Name {| … |}` call already matches it.
//
// The Feliz mirror of react's `walker-user-components.test.ts` and vue's
// `vue-user-components.test.ts`, plus the shape pins the other frontends don't
// need.  A Feliz app is ONE Elmish program, so a component's `state {}` /
// `action`s FOLD into it (Model field + Msg case + update arm, exactly as a
// `store` does) and its `derived` becomes a plain `let` — the function gains
// `model` / `dispatch` as leading curried params where it needs them.  What
// still defers is what would name Msg/Model wiring nothing emits (a bare
// `model`, an async-effect action, a form / store read), and those call sites
// keep the honest comment rather than calling a function never written.
// ---------------------------------------------------------------------------

const sys = (uiBody: string) => `
  system S {
    subdomain M { context Sales {
      aggregate Order { customerId: string }
      repository Orders for Order { }
    } }
    api SalesApi from M
    ui WebApp {
      api Sales: SalesApi
${uiBody}
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node contexts: [Sales] serves: SalesApi dataSources: [salesState] port: 3000 }
    deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3005 }
  }
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("user components — Feliz", () => {
  it("emits an F# props function with the used params bound, and no give-up comment", async () => {
    const fs = await appFs(
      sys(`
      component TierBadge(label: string, level: int) {
        body: Stack { Text { label }, Text { level > 2 ? "high" : "low" } }
      }
      page Home { route: "/" body: Stack { TierBadge(label: "gold", level: 3) } }`),
    );
    expect(fs).toContain("module Components =");
    expect(fs).toContain("open Components");
    expect(fs).toContain("    let TierBadge (props: {| label: string; level: int |}) =");
    expect(fs).toContain("        let label = props.label");
    expect(fs).toContain("        let level = props.level");
    // The walked body landed inside the function (the `Text { label }` slot).
    expect(fs).toMatch(/let TierBadge[\s\S]*?Html\.text \(string \(label\)\)/);
    expect(fs).not.toContain("unknown layout component");
  });

  it("renders the call site as the props record the extern seam already spells", async () => {
    const fs = await appFs(
      sys(`
      component TierBadge(label: string, level: int) { body: Text { label } }
      page Home { route: "/" body: Stack { TierBadge(label: "gold", level: 3) } }`),
    );
    expect(fs).toContain('TierBadge {| label = "gold"; level = 3 |}');
  });

  it("declares the component BEFORE the view that calls it (F# is order-sensitive)", async () => {
    const fs = await appFs(
      sys(`
      component TierBadge(label: string) { body: Text { label } }
      page Home { route: "/" body: Stack { TierBadge(label: "gold") } }`),
    );
    const decl = fs.indexOf("let TierBadge (props:");
    const open = fs.indexOf("open Components");
    const view = fs.search(/^let \w*[Vv]iew \(model: Model\)/m);
    expect(decl).toBeGreaterThan(-1);
    expect(view).toBeGreaterThan(-1);
    // module member, then the `open` that re-exposes it, then the caller.
    expect(decl).toBeLessThan(open);
    expect(open).toBeLessThan(view);
  });

  it("binds only the params the body reads (an unread param stays props-only)", async () => {
    const fs = await appFs(
      sys(`
      component TierBadge(label: string, level: int) { body: Text { label } }
      page Home { route: "/" body: Stack { TierBadge(label: "gold", level: 3) } }`),
    );
    // `level` is part of the props type (the call site fills it) but has no local.
    expect(fs).toContain("let TierBadge (props: {| label: string; level: int |}) =");
    expect(fs).toContain("let label = props.label");
    expect(fs).not.toContain("let level = props.level");
  });

  it("a param-less component takes unit, matching the seam's `Name ()` call", async () => {
    const fs = await appFs(
      sys(`
      component Ribbon() { body: Text { "sale" } }
      page Home { route: "/" body: Stack { Ribbon() } }`),
    );
    expect(fs).toContain("let Ribbon () =");
    expect(fs).toContain("Ribbon ()");
  });

  it("a stateful component folds into the one Elmish program instead of vanishing", async () => {
    // A Feliz app is one Elmish program, so a component's `state {}` becomes a
    // Model field and its `action` a Msg case + update arm — exactly the fold a
    // `store` already gets.  Before this the whole component was dropped: no
    // declaration, and `unknown layout component: Counter` at the call site.
    const fs = await appFs(
      sys(`
      component Counter(caption: string) {
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Text { caption }, Text { string(n) }, Button(label: "+", onClick: bump) }
      }
      page Home { route: "/" body: Stack { Counter(caption: "hits") } }`),
    );
    // The function takes Model + dispatch as LEADING CURRIED params (not props
    // fields, which every non-stateful call site would then have to spell).
    expect(fs).toContain(
      "    let Counter (model: Model) (dispatch: Msg -> unit) (props: {| caption: string |}) =",
    );
    // Its own action binds a dispatcher, the way a page view's preamble does.
    expect(fs).toContain("        let bump () = dispatch Bump");
    // The state cell reads off the single Model…
    expect(fs).toMatch(/let Counter[\s\S]*?model\.N/);
    // …because it IS a field of it, with the Msg case + update arm to match.
    expect(fs).toContain("  N: int");
    expect(fs).toContain("  | Bump");
    expect(fs).toContain("  | Bump ->");
    // And the call site passes both.
    expect(fs).toContain('Counter model dispatch {| caption = "hits" |}');
    expect(fs).not.toContain("unknown layout component");
  });

  it("a `derived` binding emits as an F# let, read bare by the body", async () => {
    // `derived` is a pure function of the props — no MVU wiring needed at all.
    // It used to disqualify the component anyway, because the walker spelled a
    // derived read `model.<Name>`: an Elmish Model field nothing declares.
    const fs = await appFs(
      sys(`
      component TierBadge(score: int) {
        derived tier: string = score > 90 ? "gold" : "silver"
        derived shout: string = tier.toUpper()
        body: Stack { Text { tier }, Text { shout } }
      }
      page Home { route: "/" body: Stack { TierBadge(score: 95) } }`),
    );
    // Props-only: no Model, no dispatch.
    expect(fs).toContain("    let TierBadge (props: {| score: int |}) =");
    expect(fs).toContain('        let tier = (if (score > 90) then "gold" else "silver")');
    // A later derived reads an earlier one as the bare `let` it is.
    expect(fs).toContain("        let shout = (tier.ToUpper())");
    // The body reads them bare too — NOT `model.Tier`.
    expect(fs).toMatch(/let TierBadge[\s\S]*?Html\.text \(string \(tier\)\)/);
    expect(fs).not.toContain("model.Tier");
    expect(fs).toContain("TierBadge {| score = 95 |}");
    expect(fs).not.toContain("unknown layout component");
  });

  it("a param only a `derived` reads is still bound as a local", async () => {
    // `usedParams` is reported by the BODY walk, which never sees the derived
    // expressions — so a param referenced only there would have no `let` and the
    // derived would name nothing.
    const fs = await appFs(
      sys(`
      component TierBadge(score: int, label: string) {
        derived tier: string = score > 90 ? "gold" : "silver"
        body: Text { tier }
      }
      page Home { route: "/" body: Stack { TierBadge(score: 95, label: "x") } }`),
    );
    expect(fs).toContain("        let score = props.score");
    // `label` is read by neither, so it stays a props field with no local.
    expect(fs).not.toContain("let label = props.label");
  });

  it("an aggregate-typed param whose wire record this app emits types as that record", async () => {
    const fs = await appFs(
      sys(`
      component OrderLine(order: Order) { body: Text { order.customerId } }
      page Home {
        route: "/"
        body: QueryView { of: Sales.Order.all, data: rows => Stack {
          For { each: rows, o => OrderLine(order: o) }
        } }
      }`),
    );
    // The read emits `type Order = { … }`, so the param is spellable.
    expect(fs).toContain("type Order =");
    expect(fs).toContain("let OrderLine (props: {| order: Order |}) =");
    expect(fs).toContain("OrderLine {| order = o |}");
  });

  it("an aggregate-typed param with NO emitted wire record stays deferred", async () => {
    // Nothing in this ui reads `Order`, so App.fs carries no `type Order` — the
    // param has no F# spelling here, so naming it would emit code that cannot
    // compile.  Deferral keeps the gap visible instead.
    const fs = await appFs(
      sys(`
      component OrderLine(order: Order) { body: Text { order.customerId } }
      page Home { route: "/" body: Stack { Heading { "home" } } }`),
    );
    expect(fs).not.toContain("type Order =");
    expect(fs).not.toContain("let OrderLine (props:");
  });

  it("a component named after a wire record is scoped by the module, not dropped", async () => {
    // Measured, not assumed: with the decl at App.fs top level, `let Order`
    // beside the emitted `type Order` is `error FABLE: Cannot have two module
    // members with same name: Order`.  The nested module + `open` makes that
    // impossible for EVERY App.fs member (records, `Model`, `Api`, a hoisted grid
    // child) without enumerating any of them — and the call site is unchanged,
    // because a PascalCase value in scope beside a same-named type is
    // unambiguous in F#.
    const fs = await appFs(
      sys(`
      component Order(order: Order) { body: Text { order.customerId } }
      page Home {
        route: "/"
        body: QueryView { of: Sales.Order.all, data: rows => Stack {
          For { each: rows, o => Order(order: o) }
        } }
      }`),
    );
    expect(fs).toContain("type Order =");
    expect(fs).toContain("    let Order (props: {| order: Order |}) =");
    expect(fs).toContain("Order {| order = o |}");
    // The record type stays a TOP-LEVEL member; the component is a module one.
    expect(fs).toMatch(/^type Order =/m);
    expect(fs).not.toMatch(/^let Order \(props:/m);
  });

  it("an extern component still binds by module (the other flavour is untouched)", async () => {
    const fs = await appFs(
      sys(`
      component OrderChart(caption: string) extern from "widgets/order_chart"
      component TierBadge(label: string) { body: Text { label } }
      page Home {
        route: "/"
        body: Stack { OrderChart(caption: "Q3"), TierBadge(label: "gold") }
      }`),
    );
    expect(fs).toContain("open Widgets.OrderChart");
    expect(fs).toContain('OrderChart {| caption = "Q3" |}');
    // A walked component is declared in THIS module, so it contributes no `open`.
    expect(fs).not.toContain("open TierBadge");
    expect(fs).toContain("let TierBadge (props: {| label: string |}) =");
  });

  it("a component invoking another walked component resolves it in-module", async () => {
    const fs = await appFs(
      sys(`
      component Ribbon() { body: Text { "sale" } }
      component TierBadge(label: string) { body: Stack { Text { label }, Ribbon() } }
      page Home { route: "/" body: Stack { TierBadge(label: "gold") } }`),
    );
    expect(fs.indexOf("let Ribbon () =")).toBeLessThan(fs.indexOf("let TierBadge (props:"));
    expect(fs).toMatch(/let TierBadge[\s\S]*?Ribbon \(\)/);
  });

  it("the CALLEE is declared first even when the .ddd declares the caller first", async () => {
    // F# resolves names top-to-bottom, so emitting in `.ddd` order would put
    // `Ribbon` after the `TierBadge` that calls it — "The value or constructor
    // 'Ribbon' is not defined".  Source order is not a compilability contract, so
    // the emitter sorts by the call graph.
    const fs = await appFs(
      sys(`
      component TierBadge(label: string) { body: Stack { Text { label }, Ribbon() } }
      component Ribbon() { body: Text { "sale" } }
      page Home { route: "/" body: Stack { TierBadge(label: "gold") } }`),
    );
    expect(fs.indexOf("let Ribbon () =")).toBeLessThan(fs.indexOf("let TierBadge (props:"));
  });

  // -------------------------------------------------------------------------
  // READ-BEARING components.  Until this shipped, a component whose body issued
  // an api read was dropped WHOLE — no `let`, and every call site rendered
  // `(* unknown layout component: … *)`.  Valid F#, missing UI.
  //
  // An Elmish read is not a per-view hook: it is a field on the ONE `Model` that
  // the init `Cmd` fills.  So the component's function simply TAKES the Model
  // (`readsForUi` now collects component bodies, so the field exists), and the
  // call site passes the `model` its page view was handed.
  // -------------------------------------------------------------------------
  it("a read-bearing component takes the Model and every call site passes it", async () => {
    const fs = await appFs(
      sys(`
      component RecentOrders(title: string) {
        body: Stack {
          Heading { title, level: 2 },
          QueryView { of: Sales.Order.all, data: rows => Stack {
            For { each: rows, o => Text { o.customerId } }
          } }
        }
      }
      page Home { route: "/" body: Stack { RecentOrders(title: "Recent") } }
      page Other { route: "/other" body: Stack { RecentOrders(title: "Again") } }`),
    );
    // The read's Model field is declared (component bodies feed `readsForUi`).
    expect(fs).toMatch(/type Model =[\s\S]*?AllOrders: Remote<Order list>/);
    // The component function takes it as a LEADING CURRIED param — the props
    // record stays exactly the declared props.
    expect(fs).toContain("let RecentOrders (model: Model) (props: {| title: string |}) =");
    expect(fs).toContain("model.AllOrders");
    // Both call sites apply it, and neither degrades.
    expect(fs).toContain(`RecentOrders model {| title = "Recent" |}`);
    expect(fs).toContain(`RecentOrders model {| title = "Again" |}`);
    expect(fs).not.toContain("unknown layout component");
  });

  it("a paramless read-bearing component applies the Model then unit", async () => {
    const fs = await appFs(
      sys(`
      component RecentOrders() {
        body: QueryView { of: Sales.Order.all, data: rows => Stack {
          For { each: rows, o => Text { o.customerId } }
        } }
      }
      page Home { route: "/" body: Stack { RecentOrders() } }`),
    );
    expect(fs).toContain("let RecentOrders (model: Model) () =");
    expect(fs).toContain("RecentOrders model ()");
    expect(fs).not.toContain("unknown layout component");
  });

  it("a byId read in a component stays deferred — no page case fires its Cmd", async () => {
    // A `byId` read's fetch is issued by `pageCmd` on ROUTE entry, keyed to the
    // hosting page's `Page` case.  A component has none, so `collectComponentReads`
    // declines to declare the Model field — and the emitter must then decline the
    // component too, rather than emitting `model.OrderById` against a field the
    // record does not carry (which is exactly what an unguarded read path did).
    const fs = await appFs(
      sys(`
      component OneOrder() {
        body: QueryView { of: Sales.Order.byId(id), single: true, data: o => Text { o.customerId } }
      }
      page Detail { route: "/orders/:id" body: Stack { OneOrder() } }`),
    );
    expect(fs).not.toContain("let OneOrder");
    expect(fs).not.toContain("model.OrderById");
    expect(fs).toContain("unknown layout component: OneOrder");
  });
});
