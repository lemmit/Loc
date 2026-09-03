// `loom.user-component-deferred-target` — a user `component` whose SHAPE the
// Feliz / Angular / Flutter component emitter FILTERS OUT.
//
// THE SILENT VANISH.  All three emitters build their emitted set by filtering
// (`emitFelizUserComponents` / `emitAngularUserComponents` /
// `emittableComponentParams`), and a filtered component is not degraded — it is
// absent.  Its name never enters the walker's `userComponents` map, so every
// call site falls through to `walk()`'s give-up comment
// (`(* unknown layout component: X *)` on Feliz,
// `<!-- unknown layout component: X -->` on Angular,
// `const SizedBox.shrink() /* unknown layout component: X */` on Flutter).
// Declaration and use vanish together: `ddd parse` clean, codegen clean,
// `dotnet fable` / `ng build` / `flutter analyze` clean, and the component is
// simply not in the app.
//
// WHY FLUTTER IS HERE NOW.  The gate shipped covering two frameworks while
// Flutter's emitter was already filtering shapes of its own — because BOTH the
// gate's framework set and THIS FILE's matrix type were hand-written literals,
// so nothing re-derived which emitters actually filter.  The
// `FILTERING_FRAMEWORKS_ARE_DERIVED` block at the bottom closes that: it renders
// one probe battery through EVERY frontend and fails when a framework drops a
// probe without being in `COMPONENT_FILTERING_FRAMEWORKS`.
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
// list was MEASURED rather than read off the emitter source.  Two shapes the
// FELIZ emitter's comments still claim to defer (a `derived` reading
// `currentUser`, a form primitive in a component body) turned out to emit fine
// there, and are deliberately NOT gated for feliz — while the same
// `currentUser` shape DOES defer on Flutter and is gated there.  Per-framework,
// measured, never inferred from a sibling.
//
// The `SUPPORTED` rows are the other direction: shapes an emitter renders, so
// the gate must stay silent on them (`only:` narrows a row to the frameworks it
// is a control for).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  COMPONENT_DEFERRALS,
  COMPONENT_FILTERING_FRAMEWORKS,
} from "../../src/ir/validate/checks/ui-checks.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFilesUnchecked } from "../_helpers/generate.js";
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
      operation retitle(t: string) { customerId := t }
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
/** The frameworks the gate covers — read from the gate itself, never restated,
 *  so a row can only name a framework the gate actually gates. */
type FilteringFramework = keyof typeof COMPONENT_DEFERRALS;

const MATRIX: ReadonlyArray<{
  framework: FilteringFramework;
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
  // --- Flutter -------------------------------------------------------------
  // `emittableComponentParams` → `usesStores`: a store is a Riverpod provider,
  // so reaching it needs the `WidgetRef` only the page path carries.
  {
    framework: "flutter",
    shape: "store field read in the body",
    reason: /its body reads store 'cart'/,
    emitter: "flutter/component-emit.ts `emittableComponentParams` (`usesStores`)",
    ui: `${STORE}
    component P() { body: Text { string(cart.count) } }
    page Home { route: "/" body: Stack { P() } }`,
  },
  // `needsPageShell` → `usesRouteId`.  The `id` local is bound by
  // `index.ts`'s `routeArgBindings`, on a PAGE.  Before this arm the guard ran
  // only for a READ-BEARING component, so a bare `id` body read emitted
  // `Text('${id}')` — `Undefined name 'id'` Dart.
  {
    framework: "flutter",
    shape: "bare route-id read in the body, with no api read",
    reason: /its body reads the route `id`/,
    emitter: "flutter/component-emit.ts `needsPageShell` (`usesRouteId`)",
    ui: `
    component P() { body: Text { id } }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  {
    framework: "flutter",
    shape: "`byId(id)` read in the body",
    reason: /its body reads the route `id`/,
    emitter: "flutter/component-emit.ts `needsPageShell` (`usesRouteId`)",
    ui: `
    component P() {
      body: QueryView { of: Sales.Order.byId(id), single: true, data: o => Text { o.customerId } }
    }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  {
    framework: "flutter",
    shape: "`DestroyForm` in the body",
    reason: /renders `DestroyForm`/,
    emitter: "flutter/flutter-target.ts `renderDestroyForm` sets `ctx.usesRouteId`",
    ui: `
    component P() { body: DestroyForm { of: Order } }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  {
    framework: "flutter",
    shape: "`OperationForm { of:, op: }` in the body",
    reason: /renders `OperationForm \{ of: Order, op: retitle \}`/,
    emitter: "flutter/flutter-target.ts `renderOperationForm` sets `ctx.usesRouteId`",
    ui: `
    component P() { body: OperationForm { of: Order, op: retitle } }
    page Detail { route: "/orders/:id" body: Stack { P() } }`,
  },
  // `isReadConsumer` → `!isStateful`.  EITHER HALF ALONE EMITS FINE (a
  // `StatefulWidget`, a `ConsumerWidget`) — the pairing is the arm, which is
  // why the SUPPORTED rows below carry each half on its own.
  {
    framework: "flutter",
    shape: "`state {}` AND an api read (would need a ConsumerStatefulWidget)",
    reason: /carries `state \{\}` AND issues a `Order\.all\(…\)` read/,
    emitter: "flutter/component-emit.ts `isReadConsumer` (`!isStateful`)",
    ui: `
    component P() {
      state { n: int = 0 }
      action bump() { n := n + 1 }
      body: Stack {
        QueryView { of: Sales.Order.all, data: rows => Text { string(rows.length) } },
        Button { "+", onClick: bump }
      }
    }
    page Home { route: "/" body: Stack { P() } }`,
  },
  // `candidates` → `derivedNeedsShell`.  All three legs reproduce on Flutter
  // (the `currentUser` one does NOT on Feliz — hence a Flutter-only row).
  {
    framework: "flutter",
    shape: "`derived` reading the route id",
    reason: /`derived who` reads the route `id`/,
    emitter: "flutter/component-emit.ts `derivedNeedsShell`",
    ui: `
    component P(label: string) { derived who: string = id  body: Text { who } }
    page Detail { route: "/orders/:id" body: Stack { P(label: "a") } }`,
  },
  {
    framework: "flutter",
    shape: "`derived` reading a store field",
    reason: /`derived n` reads store 'cart'/,
    emitter: "flutter/component-emit.ts `derivedNeedsShell`",
    ui: `${STORE}
    component P() { derived n: int = cart.count  body: Text { string(n) } }
    page Home { route: "/" body: Stack { P() } }`,
  },
];

/** Shapes EVERY filtering emitter renders — the gate must not fire on them.
 *  Measured on this HEAD (each emits a real component and no give-up comment).
 *  `only` narrows a row to the frameworks it is a negative control FOR. */
const SUPPORTED: ReadonlyArray<{
  shape: string;
  ui: string;
  only?: readonly FilteringFramework[];
}> = [
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
  // The two HALVES of the Flutter `ConsumerStatefulWidget` arm.  Each on its
  // own emits (a `StatefulWidget`, a `ConsumerWidget`); only the PAIRING is
  // deferred — so these are what prove the matrix row is about the combination
  // and not about `state {}` or reads in general.
  {
    shape: "`state {}` with NO read (the stateful half alone)",
    only: ["flutter"],
    ui: `
    component P() {
      state { n: int = 0 }
      action bump() { n := n + 1 }
      body: Stack { Text { string(n) }, Button { "+", onClick: bump } }
    }
    page Home { route: "/" body: Stack { P() } }`,
  },
  // Flutter has NO param filter at all — the shapes Feliz's `propType` and
  // Angular's `hasSlotOrActionParam` refuse each emit here, so the gate must
  // stay silent on them for `flutter` specifically.
  {
    shape: "a `slot` param",
    only: ["flutter"],
    ui: `
    component P(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`,
  },
  {
    shape: "an `action` param",
    only: ["flutter"],
    ui: `
    component P(onPick: action(Order)) { body: Button { "Pick" } }
    page Home { route: "/" body: Stack { P(onPick: o => { navigate(Home) }) } }`,
  },
  {
    shape: "an optional param",
    only: ["flutter"],
    ui: `
    component P(label: string?) { body: Text { "x" } }
    page Home { route: "/" body: Stack { P(label: "a") } }`,
  },
  {
    shape: "an api read whose arg feeds on a component param",
    only: ["flutter"],
    ui: `
    component P(oid: string) {
      body: QueryView { of: Sales.Order.byId(oid), single: true, data: o => Text { o.customerId } }
    }
    page Home { route: "/" body: Stack { P(oid: "x") } }`,
  },
];

/** The `currentUser` arms need an auth-bearing system (a `user {}` block, an
 *  `auth {}` provider and an `auth: ui` frontend), so they get their own
 *  fixture rather than dragging that machinery through every other row. */
const authSys = (uiBody: string) => `
system Helpdesk {
  user { id: string  role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Support { context Tickets {
    aggregate Ticket { subject: string }
    repository Tickets for Ticket { }
  } }
  api SupportApi from Support
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp {
    framework: flutter
    api Support: SupportApi
${uiBody}
  }
  deployable web { platform: flutter targets: api ui: WebApp { Support: api } port: 3005 auth: ui }
}`;

const diagsOf = async (src: string) => {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected AST errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
};
const diagCodes = async (src: string): Promise<string[]> => (await diagsOf(src)).map((d) => d.code);

/** The emitted frontend pages, whichever frontend emitted them.  Every
 *  caller is an "emitter really drops it" leg: it generates from the very
 *  model the gate under test rejects, to prove the degradation arm is still
 *  real — so the checked helper would (correctly) refuse each fixture. */
async function frontendSources(src: string): Promise<Map<string, string>> {
  const files = await generateSystemFilesUnchecked(
    src,
    "each MATRIX fixture is rejected by loom.user-component-deferred-target on purpose; this leg emits from it to prove the emitter arm the gate documents still degrades",
  );
  return new Map(
    [...files.entries()].filter(
      ([k]) => k.endsWith("App.fs") || k.includes("/src/app/") || k.endsWith(".dart"),
    ),
  );
}

/** The generated file that would HOLD the component, per framework — asserted
 *  absent (or without the component) on every MATRIX row, so "the emitter drops
 *  it" is proven by the missing declaration and not only by the call-site
 *  sentinel. */
function assertNoComponentEmitted(framework: FilteringFramework, sources: Map<string, string>) {
  const all = [...sources.values()].join("\n");
  if (framework === "angular") {
    expect([...sources.keys()].some((k) => k.endsWith("src/app/components/P.ts"))).toBe(false);
  } else if (framework === "flutter") {
    // `components.dart` is emitted only for components that survived the
    // filter, so either it is absent or it declares no `P`.
    expect(all).not.toMatch(/class P extends /);
  } else {
    expect(all).not.toMatch(/let P \(/);
  }
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
      assertNoComponentEmitted(row.framework, sources);
    }, 120_000);

    it(`${label} — a React host renders it, so the gate stays quiet there`, async () => {
      const codes = await diagCodes(sys(row.ui, "react"));
      expect(codes, `${label}: gated on react, which emits user components for real`).not.toContain(
        CODE,
      );
    });
  }

  for (const row of SUPPORTED) {
    for (const framework of Object.keys(COMPONENT_DEFERRALS) as FilteringFramework[]) {
      if (row.only && !row.only.includes(framework)) continue;
      it(`${framework}: ${row.shape} is emitted, so the gate stays quiet`, async () => {
        expect(await diagCodes(sys(row.ui, framework))).not.toContain(CODE);
      });
      it(`${framework}: ${row.shape} really IS emitted (the negative control is real)`, async () => {
        const all = [...(await frontendSources(sys(row.ui, framework))).values()].join("\n");
        expect(
          all,
          `${framework}: ${row.shape} is listed as SUPPORTED, but the emitter dropped it — ` +
            `either add a MATRIX arm for it or fix the emitter.`,
        ).not.toContain("unknown layout component: P");
      }, 120_000);
    }
  }

  it("an `extern` component is never gated — the emitter always wires that flavour", async () => {
    const ui = `
    component P(head: slot) extern from "widgets/p"
    page Home { route: "/" body: Stack { P(head: Text { "hi" }) } }`;
    for (const framework of Object.keys(COMPONENT_DEFERRALS)) {
      expect(await diagCodes(sys(ui, framework))).not.toContain(CODE);
    }
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

  // --- Flutter's `currentUser` arms (their own auth-bearing fixture) -------
  //
  // Both are Flutter-ONLY: Feliz's `derivedNeedsPageScope` has a `currentUser`
  // leg too, but it was measured NOT to reproduce there, so it is deliberately
  // ungated for feliz (see the "NOT mirrored" note in ui-checks.ts).
  const CURRENT_USER_ARMS: ReadonlyArray<{ shape: string; reason: RegExp; ui: string }> = [
    {
      shape: "`derived` reading a `currentUser` claim",
      reason: /`derived who` reads the session `currentUser`/,
      ui: `
    component P() { derived who: string = currentUser.id  body: Text { who } }
    page Home { route: "/" body: Stack { P() } }`,
    },
    {
      shape: "a `currentUser` claim read in the body",
      reason: /its body reads a `currentUser` claim/,
      ui: `
    component P() { body: Text { currentUser.id } }
    page Home { route: "/" body: Stack { P() } }`,
    },
  ];

  for (const row of CURRENT_USER_ARMS) {
    it(`flutter: ${row.shape} — the gate fires`, async () => {
      const mine = (await diagsOf(authSys(row.ui)))
        .filter((d) => d.code === CODE)
        .map((d) => d.message);
      expect(mine, `expected ${CODE} for ${row.shape}`).not.toEqual([]);
      expect(
        mine.some((m) => row.reason.test(m)),
        `${row.shape}: fired, but not from THIS arm.  Got:\n${mine.join("\n")}`,
      ).toBe(true);
    });

    it(`flutter: ${row.shape} — the emitter really drops it`, async () => {
      const sources = await frontendSources(authSys(row.ui));
      const all = [...sources.values()].join("\n");
      expect(
        all,
        `${row.shape}: the emitter no longer drops it — DELETE the arm from ui-checks.ts ` +
          `in the same PR.  (Before the fix this shape emitted \`Text('\${currentUser.id}')\` ` +
          `in a StatelessWidget, i.e. \`Undefined name 'currentUser'\` Dart.)`,
      ).toContain("unknown layout component: P");
      assertNoComponentEmitted("flutter", sources);
      // …and specifically NOT as broken Dart naming a local nothing declares.
      expect(all).not.toMatch(/class P extends [A-Za-z]+ \{[\s\S]*?currentUser/);
    }, 120_000);
  }

  // ---------------------------------------------------------------------
  // FILTERING_FRAMEWORKS_ARE_DERIVED — the ratchet the gate was missing.
  //
  // `COMPONENT_FILTERING_FRAMEWORKS` is a hand-written literal and has to be:
  // `src/ir/` may not import `src/generator/` (the one-directional pipeline),
  // so the set cannot be read off the emitters at validation time.  What makes
  // it ratchet is this test DERIVING the same set behaviourally — one probe
  // battery, rendered through EVERY frontend, with the walker's own give-up
  // comment as the signal.  A frontend that starts filtering (exactly what
  // Flutter did) drops a probe and fails here until it joins the set and grows
  // its arms.
  // ---------------------------------------------------------------------

  /** Every frontend a ui can be rendered through — the population the derived
   *  set is drawn from.  Kept beside the probe so a NEW frontend is a
   *  compile-time-visible edit here rather than a silent omission. */
  const ALL_FRONTENDS = ["react", "vue", "svelte", "angular", "feliz", "flutter"] as const;

  /** One ui carrying every shape any known emitter filters on, so a single
   *  generate per framework answers "does this emitter filter?".  Each
   *  component is named `P<n>` and called from a `:id` page, so a route-id
   *  shape is legal. */
  const PROBE_BATTERY = `${STORE}
    component P1(head: slot) { body: Card { head } }
    component P2(onPick: action(Order)) { body: Button { "Pick" } }
    component P3(label: string?) { body: Text { "x" } }
    component P4() { body: Text { string(cart.count) } }
    component P5() { body: Text { id } }
    component P6() {
      body: QueryView { of: Sales.Order.byId(id), single: true, data: o => Text { o.customerId } }
    }
    component P7() {
      state { n: int = 0 }
      action bump() { n := n + 1 }
      body: Stack {
        QueryView { of: Sales.Order.all, data: rows => Text { string(rows.length) } },
        Button { "+", onClick: bump }
      }
    }
    component P8(label: string) { derived who: string = id  body: Text { who } }
    component P9(oid: string) {
      body: QueryView { of: Sales.Order.byId(oid), single: true, data: o => Text { o.customerId } }
    }
    component P10() { body: DestroyForm { of: Order } }
    page Detail {
      route: "/orders/:id"
      body: Stack {
        P1(head: Text { "hi" }), P2(onPick: o => { navigate(Detail) }), P3(label: "a"),
        P4(), P5(), P6(), P7(), P8(label: "a"), P9(oid: "x"), P10()
      }
    }`;

  for (const framework of ALL_FRONTENDS) {
    it(`${framework}: whether its component emitter FILTERS is derived, not declared`, async () => {
      const all = [...(await frontendSources(sys(PROBE_BATTERY, framework))).values()].join("\n");
      const dropped = [...all.matchAll(/unknown layout component: (P\d+)/g)].map((m) => m[1]);
      const filters = dropped.length > 0;
      expect(
        filters,
        filters
          ? `${framework}'s component emitter DROPS ${[...new Set(dropped)].sort().join(", ")} ` +
              `but is not in COMPONENT_FILTERING_FRAMEWORKS — every dropped component vanishes ` +
              `with no diagnostic, which is the exact bug this gate exists to stop.  Add ` +
              `'${framework}' to the set in ui-checks.ts, write its deferral arms in ` +
              `COMPONENT_DEFERRALS, and add a MATRIX row per arm here.`
          : `${framework} is listed in COMPONENT_FILTERING_FRAMEWORKS but its emitter dropped ` +
              `NOTHING from the probe battery — if it grew the shapes, delete its arms and its ` +
              `membership in the same PR.`,
      ).toBe(COMPONENT_FILTERING_FRAMEWORKS.has(framework));
    }, 180_000);
  }

  it("every filtering framework has deferral arms, and vice versa", () => {
    expect(Object.keys(COMPONENT_DEFERRALS).sort()).toEqual(
      [...COMPONENT_FILTERING_FRAMEWORKS].sort(),
    );
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
