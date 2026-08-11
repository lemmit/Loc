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
// its props record, spliced into `App.fs` AHEAD of the page views (F# is
// order-sensitive).  The props record is what keeps ONE call form for both
// flavours — the extern seam's `Name {| … |}` call already matches it.
//
// The Feliz mirror of react's `walker-user-components.test.ts` and vue's
// `vue-user-components.test.ts`, plus the deferral pins the other frontends
// don't need (a Feliz app is one Elmish program, so a component owning `state {}`
// / `derived` / `action`s is an MVU design question, not a rendering gap — it
// stays out of the emitted set and its call site keeps the comment).
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
    expect(fs).toContain("let TierBadge (props: {| label: string; level: int |}) =");
    expect(fs).toContain("let label = props.label");
    expect(fs).toContain("let level = props.level");
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
    const view = fs.search(/let \w*[Vv]iew \(model: Model\)/);
    expect(decl).toBeGreaterThan(-1);
    expect(view).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(view);
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

  it("a stateful component is DEFERRED, not silently half-emitted", async () => {
    // A Feliz app is one Elmish program: a component's own `state {}` needs
    // Model/Msg/update wiring (a per-component sub-model).  So it stays out of the
    // emitted set — no declaration, and the call site keeps the honest comment
    // rather than calling a function that was never written.
    const fs = await appFs(
      sys(`
      component Counter(caption: string) {
        state { n: int = 0 }
        body: Stack { Text { caption }, Text { string(n) } }
      }
      page Home { route: "/" body: Stack { Counter(caption: "hits") } }`),
    );
    expect(fs).not.toContain("let Counter (props:");
    expect(fs).toContain("unknown layout component: Counter");
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
    // Both declared, and the inner one BEFORE its caller (declaration order
    // follows the ui's, which is the order F# needs here).
    expect(fs.indexOf("let Ribbon () =")).toBeLessThan(fs.indexOf("let TierBadge (props:"));
    expect(fs).toMatch(/let TierBadge[\s\S]*?Ribbon \(\)/);
  });
});
