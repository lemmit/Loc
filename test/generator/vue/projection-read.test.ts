// M-T1.3 Phase 1 — a Vue page READS a query-time projection.
//
// The Vue half of `test/generator/react/projection-read.test.ts`, which this
// mirrors assertion-for-assertion.  #2324 shipped the read path on React only:
// `PROJECTION_READ_FRAMEWORKS` gated every other frontend honestly, because a
// page reading a projection on one of them emitted an unresolved receiver
// (`undefined.<Projection>`) — a runtime TypeError AND a build break.
//
// What the port actually costs, and why it is this small: the detector
// (Pattern H), the readable-projection set, and the singleton-before-`autoPaged`
// binding in `_walker/primitives/controls.ts` were already framework-agnostic
// on `main`.  Vue supplies two things — the `buildHookUse` arm and the
// `src/api/projections.ts` emit — and reuses the SHARED
// `_frontend/projections-module.ts` through its existing `queryPackage` option,
// because `@tanstack/vue-query`'s `useQuery` is API-compatible with the React
// one.  The cross-framework assertion at the bottom pins that: the two modules
// must differ in the import specifier and NOTHING else.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The same system as the React suite, with the frontend on `platform: vue`. */
const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order {}
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        select orders = count, revenue = sum(o.total)
      }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        QueryView {
          of: Sales.SalesTotals,
          empty: Text { "No data" },
          data: t => Group {
            Stat { "Orders", t.orders },
            Stat { "Revenue", Money { t.revenue } }
          }
        }
      }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: vue targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The vue deployable's files, path-prefixed off the system tree. */
async function files(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

describe("vue projection client", () => {
  it("emits a `src/api/projections.ts` module", async () => {
    expect((await files()).has("src/api/projections.ts")).toBe(true);
  });

  it("imports the VUE query package, not the React one", async () => {
    // The single axis on which Vue diverges from React in this module.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain(`import { useQuery } from "@tanstack/vue-query";`);
    expect(m).not.toContain("@tanstack/react-query");
  });

  it("mirrors the backend row shape field-for-field", async () => {
    // Both sides read the same `wireShape`, so they cannot drift.  Money is the
    // interesting one: `moneySchema` parses the wire string into a Decimal.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export const SalesTotalsResponse = z.object({");
    expect(m).toContain("orders: z.number().int(),");
    expect(m).toContain("revenue: moneySchema,");
    // Vue emits `src/lib/schemas.ts` at the same relative depth as React, so
    // the shared module's import path needs no per-framework knob.
    expect(m).toContain(`import { moneySchema } from "../lib/schemas";`);
  });

  it("hits the projection's own route with no arguments", async () => {
    // A singleton read takes no id and no query — the projection IS the row.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export function useSalesTotals() {");
    expect(m).toContain('queryKey: ["projections", "sales_totals"],');
    expect(m).toContain("await api.get(`/projections/sales_totals`)");
    expect(m).toContain("return SalesTotalsResponse.parse(r);");
  });

  it("is NOT emitted for a projection-free app", async () => {
    // Byte-identical output for every app that declares no readable
    // projection — the module is emitted on demand, not unconditionally.
    const plain = `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  derived display: string = code }
    repository Orders for Order {}
  } }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash { route: "/dash"  title: "D"  body: Stack { Text { "hi" } } }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: vue targets: api ui: WebApp { Sales: api } port: 3000 }
}`;
    expect((await files(plain)).has("src/api/projections.ts")).toBe(false);
  });
});

describe("vue projection read in a page", () => {
  it("resolves the read to a hoisted composable — no unresolved receiver", async () => {
    const page = (await files()).get("src/pages/dash.vue")!;
    expect(page).toContain(`import { useSalesTotals } from "../api/projections";`);
    // Vue hoists into `<script setup>` and wraps the handle so nested refs
    // read uniformly in template + script positions.
    expect(page).toContain("const salesTotals = reactive(useSalesTotals());");
    // The defect this closes.
    expect(page).not.toContain("unresolved");
    expect(page).not.toContain("undefined.SalesTotals");
  });

  it("binds SINGLE-record, since a singleton returns one object", async () => {
    // The collection semantics (`data.length === 0` / `> 0`) would read
    // `.length` on an object — always undefined, so the body would never
    // render.  Derived from the query, not from an author-written `single:`;
    // the detection lives in `_walker/primitives/controls.ts` and must precede
    // `autoPaged`, which would otherwise unwrap a `.items` the object has not.
    const page = (await files()).get("src/pages/dash.vue")!;
    expect(page).toContain(`<template v-if="salesTotals.data">`);
    expect(page).not.toContain("salesTotals.data.length");
    expect(page).not.toContain("salesTotals.data.items");
  });

  it("reads row fields straight off `.data`", async () => {
    expect((await files()).get("src/pages/dash.vue")!).toContain("salesTotals.data.orders");
  });

  it("renders a money value through the pack's formatter", async () => {
    // A `money` deserialises client-side to a decimal.js `Decimal`.  Vue's
    // mustache would happily stringify it to `[object Object]`, so the nested
    // `Money { … }` primitive must survive into the formatter call.
    expect((await files()).get("src/pages/dash.vue")!).toContain(
      "formatMoney(salesTotals.data.revenue)",
    );
  });
});

describe("the shared projections module across React and Vue", () => {
  it("differs ONLY in the query-package import", async () => {
    // The pathfinder claim, made falsifiable: `_frontend/projections-module.ts`
    // stays one shared emitter widened by options, NOT a per-framework seam.
    // If a follower ever needs to change more than a leaf string here, that is
    // the signal to widen `options` (svelte) or fork (angular/feliz/flutter) —
    // see the decision comment at the head of the module.
    const vue = (await files()).get("src/api/projections.ts")!;
    const react = (await files(SRC.replace("platform: vue", "platform: react")))!.get(
      "src/api/projections.ts",
    )!;
    expect(vue.replace("@tanstack/vue-query", "@tanstack/react-query")).toBe(react);
  });
});
