// `loom.user-component-deferred-target` — a user `component` whose SHAPE the
// Feliz / Angular component emitter FILTERS OUT.
//
// THE SILENT VANISH.  Both emitters build their emitted set by filtering
// (`emitFelizUserComponents` / `emitAngularUserComponents`), and a filtered
// component is not degraded — it is absent.  Its name never enters the walker's
// `userComponents` map, so every call site falls through to `walk()`'s give-up
// comment (`(* unknown layout component: X *)` on Feliz,
// `<!-- unknown layout component: X -->` on Angular).  Declaration and use
// vanish together: `ddd parse` clean, codegen clean, `dotnet fable` / `ng build`
// clean, and the component is simply not in the app.
//
// WHAT THIS FILE IS.  Each `MATRIX` row is one (framework, shape) arm of the
// gate, and every row is asserted TWICE:
//
//   1. the gate FIRES on it (the honest half), and
//   2. the emitter really DOES drop it — the generated pages carry
//      `unknown layout component: <Name>` and no component is emitted.
//
// (2) is what keeps this from being a gate that outlives what it describes: the
// day an emitter grows one of these shapes, the row's emitter half fails and the
// arm has to be deleted from `ui-checks.ts` in the same PR.  It is the same
// discipline `render-degradation.test.ts`'s ratchet uses ("only lists
// degradations that are still real"), applied per arm — and it is why the arm
// list was MEASURED rather than read off the emitter source: two shapes the
// emitter comments still defer (a `derived` reading `currentUser`, a form
// primitive in a component body) turned out to emit fine on this HEAD, and are
// deliberately NOT gated.
//
// The `SUPPORTED` rows are the other direction: shapes both emitters render, so
// the gate must stay silent on them.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.user-component-deferred-target";

/** One system, one component named `P`, one page that calls it.  `platform`
 *  swaps the hosting frontend; the domain is identical across every row so a
 *  difference in outcome is the SHAPE, never the fixture. */
const sys = (uiBody: string, platform: string) => `
system S {
  subdomain M { context Sales {
    aggregate Order with crudish {
      customerId: string
      total: int
      operation confirm() { }
    }
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
  deployable web { platform: ${platform} targets: api ui: WebApp { Sales: api } port: 3005 }
}`;

const STORE = `
    store cart { state { count: int = 0 }  action bump() { count := count + 1 } }`;

/** The gated matrix: one row per (framework, shape) the emitter filters.
 *  `emitter` names the filter the arm mirrors — the citation a reviewer checks
 *  the arm against. */
const MATRIX: ReadonlyArray<{
  framework: "feliz" | "angular";
  shape: string;
  emitter: string;
  /** A fragment of the arm's OWN reason text.  Asserted per row so a row is
   *  proven by ITS arm rather than by whichever arm happens to fire first — the
   *  detail/`:id` fixtures legitimately trip two. */
  reason: RegExp;
  ui: string;
}> = [
  // --- Feliz: `propType` has no props-record spelling ----------------------
  {
    framework: "feliz",
    shape: "optional param",
    reason: /parameter 'label' is optional/,
    emitter: "feliz/component-emit.ts `propType` (an F# anonymous record is exact)",
    ui: `
    component P(label: string?) { body: Text { "x" } }
    page Home { route: "/" body: Stack { P(label: "a") } }`,
  },
  {
    framework: "feliz",
    shape: "slot param",
    reason: /parameter 'head' is a `slot`/,
    emitter: "feliz/component-emit.ts `propType`",
    ui: `
    component P(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`,
  },
  {
    framework: "feliz",
    shape: "action param",
    reason: /parameter 'onPick' is an `action`/,
    emitter: "feliz/component-emit.ts `propType`",
    ui: `
    component P(onPick: action(Order)) { body: Button { "Pick" } }
    page Home { route: "/" body: Stack { P(onPick: o => { navigate(Home) }) } }`,
  },
  // --- Feliz: the walk needs a route `id` a component has none of ----------
  {
    framework: "feliz",
    shape: "`derived` reading the route id",
    reason: /`derived who` reads the route `id`/,
    emitter: "feliz/component-emit.ts `derivedNeedsPageScope`",
    ui: `
    component P(label: string) { derived who: string = id  body: Text { who } }
    page Detail { route: "/orders/:id" body: Stack { P(label: "a") } }`,
  },
  {
    framework: "feliz",
    shape: "body reading the route id",
    reason: /its body reads the route `id`/,
    emitter: "feliz/component-emit.ts `renderOne` (`result.usesRouteId`)",
    ui: `
    component P() { body: Text { id } }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  {
    framework: "feliz",
    shape: "`Action { inst.op }` in the body",
    reason: /renders `Action \{ order\.confirm \}`/,
    emitter: "feliz/feliz-target.ts `renderAction` sets `ctx.usesRouteId`",
    ui: `
    component P(order: Order) { body: Action { order.confirm } }
    page Home {
      route: "/"
      body: QueryView { of: Sales.Order.all, data: rows => Stack {
        For { each: rows, o => P(order: o) }
      } }
    }`,
  },
  {
    framework: "feliz",
    shape: "`DestroyForm` in the body",
    reason: /renders `DestroyForm`/,
    emitter: "feliz/feliz-target.ts `renderDestroyForm` sets `ctx.usesRouteId`",
    ui: `
    component P() { body: DestroyForm { of: Order } }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  // --- Feliz: Model fields the component has no claim on -------------------
  {
    framework: "feliz",
    shape: "store field read in the body",
    reason: /its body reads store 'cart'/,
    emitter: "feliz/component-emit.ts `renderOne` (`result.usedStores`)",
    ui: `${STORE}
    component P() { body: Text { string(cart.count) } }
    page Home { route: "/" body: Stack { P() } }`,
  },
  {
    framework: "feliz",
    shape: "store action bound in the body",
    reason: /its body reads store 'cart'/,
    emitter: "feliz/component-emit.ts `renderOne` (`result.usedStores`)",
    ui: `${STORE}
    component P() { body: Button(label: "+", onClick: cart.bump) }
    page Home { route: "/" body: Stack { P() } }`,
  },
  {
    framework: "feliz",
    shape: "`byId` read in the body",
    reason: /issues a `Order\.byId\(…\)` read/,
    emitter: "feliz/wire.ts `collectBodyReads` declares no Model field without a `pageCase`",
    ui: `
    component P() {
      body: QueryView { of: Sales.Order.byId(id), single: true, data: o => Text { o.customerId } }
    }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  // --- Angular -------------------------------------------------------------
  {
    framework: "angular",
    shape: "slot param",
    reason: /parameter 'head' is a `slot`/,
    emitter: "angular/components-emit.ts `hasSlotOrActionParam`",
    ui: `
    component P(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`,
  },
  {
    framework: "angular",
    shape: "optional slot param",
    reason: /parameter 'head' is a `slot`/,
    emitter: "angular/components-emit.ts `hasSlotOrActionParam` (optional-unwrapped)",
    ui: `
    component P(head: slot?) { body: Card { head } }
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`,
  },
  {
    framework: "angular",
    shape: "action param",
    reason: /parameter 'onPick' is an `action`/,
    emitter: "angular/components-emit.ts `hasSlotOrActionParam`",
    ui: `
    component P(onPick: action(Order)) { body: Button { "Pick" } }
    page Home { route: "/" body: Stack { P(onPick: o => { navigate(Home) }) } }`,
  },
  {
    framework: "angular",
    shape: "api read whose arg reads an @Input()",
    reason: /reads the `@Input\(\)` 'oid'/,
    emitter: "angular/components-emit.ts `renderOne` (the `readsAnInput` guard)",
    ui: `
    component P(oid: string) {
      body: QueryView { of: Sales.Order.byId(oid), single: true, data: o => Text { o.customerId } }
    }
    page Home { route: "/" body: Stack { P(oid: "x") } }`,
  },
];

/** Shapes BOTH emitters render — the gate must not fire on them.  Measured on
 *  this HEAD (each emits a real component and no give-up comment). */
const SUPPORTED: ReadonlyArray<{ shape: string; ui: string }> = [
  {
    shape: "a plain value param",
    ui: `
    component P(label: string) { body: Text { label } }
    page Home { route: "/" body: Stack { P(label: "a") } }`,
  },
  {
    shape: "an arg-less collection read",
    ui: `
    component P() {
      body: QueryView { of: Sales.Order.all, data: rows => Text { string(rows.length) } }
    }
    page Home { route: "/" body: Stack { P() } }`,
  },
  {
    shape: "a `derived` over its own params",
    ui: `
    component P(score: int) { derived tier: string = score > 90 ? "gold" : "silver"  body: Text { tier } }
    page Home { route: "/" body: Stack { P(score: 95) } }`,
  },
];

const diagsOf = async (src: string) => {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected AST errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
};
const diagCodes = async (src: string): Promise<string[]> => (await diagsOf(src)).map((d) => d.code);

/** The emitted frontend pages, whichever frontend emitted them. */
async function frontendSources(src: string): Promise<Map<string, string>> {
  const files = await generateSystemFiles(src);
  return new Map(
    [...files.entries()].filter(([k]) => k.endsWith("App.fs") || k.includes("/src/app/")),
  );
}

describe("loom.user-component-deferred-target", () => {
  for (const row of MATRIX) {
    const label = `${row.framework}: ${row.shape}`;

    it(`${label} — the gate fires`, async () => {
      const diags = await diagsOf(sys(row.ui, row.framework));
      const mine = diags.filter((d) => d.code === CODE).map((d) => d.message);
      expect(mine, `expected ${CODE} for ${label} (${row.emitter})`).not.toEqual([]);
      expect(
        mine.some((m) => row.reason.test(m)),
        `${label}: ${CODE} fired, but not from THIS arm — no message matched ` +
          `${row.reason}.  Got:\n${mine.join("\n")}`,
      ).toBe(true);
    });

    it(`${label} — the emitter really drops the component (the arm is still real)`, async () => {
      const sources = await frontendSources(sys(row.ui, row.framework));
      const all = [...sources.values()].join("\n");
      expect(
        all,
        `${label}: the gate claims ${row.emitter} filters this shape, but the emitter ` +
          `no longer degrades it.  If the emitter grew this shape, DELETE the arm from ` +
          `ui-checks.ts in the same PR.`,
      ).toContain("unknown layout component: P");
      if (row.framework === "angular") {
        expect([...sources.keys()].some((k) => k.endsWith("src/app/components/P.ts"))).toBe(false);
      } else {
        expect(all).not.toMatch(/let P \(/);
      }
    }, 120_000);

    it(`${label} — a React host renders it, so the gate stays quiet there`, async () => {
      const codes = await diagCodes(sys(row.ui, "react"));
      expect(codes, `${label}: gated on react, which emits user components for real`).not.toContain(
        CODE,
      );
    });
  }

  for (const row of SUPPORTED) {
    for (const framework of ["feliz", "angular"] as const) {
      it(`${framework}: ${row.shape} is emitted, so the gate stays quiet`, async () => {
        expect(await diagCodes(sys(row.ui, framework))).not.toContain(CODE);
      });
    }
  }

  it("an `extern` component is never gated — the emitter always wires that flavour", async () => {
    const ui = `
    component P(head: slot) extern from "widgets/p"
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`;
    expect(await diagCodes(sys(ui, "feliz"))).not.toContain(CODE);
    expect(await diagCodes(sys(ui, "angular"))).not.toContain(CODE);
  });

  it("names the component, the framework, the deployable and the emitter filter", async () => {
    const { model } = await parseString(
      sys(
        `
    component P(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`,
        "feliz",
      ),
    );
    const diag = validateLoomModel(enrichLoomModel(lowerModel(model))).find(
      (d) => d.code === CODE,
    )!;
    expect(diag.severity).toBe("error");
    expect(diag.message).toContain("component 'P'");
    expect(diag.message).toContain("ui 'WebApp'");
    expect(diag.message).toContain("feliz");
    expect(diag.message).toContain("deployable 'web'");
    expect(diag.message).toContain("unknown layout component: P");
    expect(diag.message).toContain("component-emit.ts");
  });

  it("resolves the framework from the ui, not the host platform", async () => {
    // A `platform: static` host serves whichever bundle the ui declares, so the
    // gate must read `ui.framework` — keying on the platform alone would miss
    // every angular ui that ships on a static host (the shape
    // `render-degradation.test.ts` retargets with).
    const ui = `
    component P(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`;
    const withFramework = sys(ui, "static").replace(
      "ui WebApp {",
      "ui WebApp {\n    framework: angular",
    );
    expect(await diagCodes(withFramework)).toContain(CODE);
    // …and the same ui on a react bundle is fine.
    const asReact = sys(ui, "static").replace("ui WebApp {", "ui WebApp {\n    framework: react");
    expect(await diagCodes(asReact)).not.toContain(CODE);
  });
});
