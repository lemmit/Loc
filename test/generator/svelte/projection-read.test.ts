// M-T1.3 Phase 1 — a Svelte page READS a query-time projection.
//
// Third leg after `test/generator/react/projection-read.test.ts` (#2324) and
// the Vue sibling (#2366), which this mirrors assertion-for-assertion.  Before
// a frontend ports, `PROJECTION_READ_FRAMEWORKS` gates it honestly, because a
// page reading a projection there emits an unresolved receiver
// (`undefined.<Projection>`) — a runtime TypeError AND a build break.
//
// What the port costs, and why it is this small: the detector (Pattern H), the
// readable-projection set, and the singleton-before-`autoPaged` binding in
// `_walker/primitives/controls.ts` were already framework-agnostic.  Svelte
// supplies the `buildHookUse` arm and the `src/lib/api/projections.ts` emit,
// and REUSES the shared `_frontend/projections-module.ts` through four leaf
// options — the shared-vs-fork rule #2366 recorded.  The cross-framework test
// at the bottom pins that those four leaves are the WHOLE divergence.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The same system as the React/Vue suites, with the frontend on
 *  `platform: svelte`. */
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
  deployable web { platform: svelte targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The svelte deployable's files, path-prefixed off the system tree. */
async function files(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

/** The generated page — SvelteKit routes it under `(app)/<route>`. */
async function dashPage(src = SRC): Promise<string> {
  const all = await files(src);
  const hit = [...all].find(([p]) => p.includes("dash") && p.endsWith("+page.svelte"));
  if (!hit) throw new Error(`no dash page emitted; got: ${[...all.keys()].join(", ")}`);
  return hit[1];
}

describe("svelte projection client", () => {
  it("emits the module under `src/lib/api/`, not `src/api/`", async () => {
    // SvelteKit's lib alias — the path divergence that drives `schemasImport`.
    const all = await files();
    expect(all.has("src/lib/api/projections.ts")).toBe(true);
    expect(all.has("src/api/projections.ts")).toBe(false);
  });

  it("uses the svelte-query factory and its THUNKED options object", async () => {
    // `createQuery(() => ({…}))`, not `useQuery({…})` — the one structural
    // divergence, and the reason `thunkOptions` exists.  Matches the shape
    // `svelte/workflow-builder.ts` already emits for instance queries.
    const m = (await files()).get("src/lib/api/projections.ts")!;
    expect(m).toContain(`import { createQuery } from "@tanstack/svelte-query";`);
    expect(m).not.toContain("@tanstack/react-query");
    expect(m).toContain("  return createQuery(() => ({");
    expect(m).toContain("  }));");
  });

  it("mirrors the backend row shape field-for-field", async () => {
    // Both sides read the same `wireShape`, so they cannot drift.  Money is the
    // interesting one: `moneySchema` parses the wire string into a Decimal.
    const m = (await files()).get("src/lib/api/projections.ts")!;
    expect(m).toContain("export const SalesTotalsResponse = z.object({");
    expect(m).toContain("orders: z.number().int(),");
    expect(m).toContain("revenue: moneySchema,");
    // One hop up from `src/lib/api/`, where React/Vue need two from `src/api/`.
    expect(m).toContain(`import { moneySchema } from "../schemas";`);
  });

  it("hits the projection's own route with no arguments", async () => {
    // A singleton read takes no id and no query — the projection IS the row.
    const m = (await files()).get("src/lib/api/projections.ts")!;
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
  deployable web { platform: svelte targets: api ui: WebApp { Sales: api } port: 3000 }
}`;
    expect((await files(plain)).has("src/lib/api/projections.ts")).toBe(false);
  });
});

describe("svelte projection read in a page", () => {
  it("resolves the read to a hoisted query — no unresolved receiver", async () => {
    const page = await dashPage();
    expect(page).toContain(`import { useSalesTotals } from "$lib/api/projections";`);
    expect(page).toContain("const salesTotals = useSalesTotals();");
    // The defect this closes.
    expect(page).not.toContain("unresolved");
    expect(page).not.toContain("undefined.SalesTotals");
  });

  it("binds SINGLE-record, since a singleton returns one object", async () => {
    // The collection semantics (`data.length === 0` / `> 0`) would read
    // `.length` on an object — always undefined, so the body would never
    // render.  Derived from the query, not from an author-written `single:`;
    // the detection lives in `_walker/primitives/controls.ts` and must precede
    // `autoPaged`, which would otherwise unwrap an `.items` the object has not.
    const page = await dashPage();
    expect(page).toContain("{:else if !salesTotals.data}");
    expect(page).not.toContain("salesTotals.data.length");
    expect(page).not.toContain("salesTotals.data.items");
  });

  it("reads row fields straight off `.data`", async () => {
    expect(await dashPage()).toContain("salesTotals.data.orders");
  });

  it("renders a money value through the pack's formatter", async () => {
    // A `money` deserialises client-side to a decimal.js `Decimal`; a bare
    // Svelte text expression would stringify it to `[object Object]`, so the
    // nested `Money { … }` primitive must survive into the formatter call.
    expect(await dashPage()).toContain("formatMoney(salesTotals.data.revenue)");
  });
});

describe("the shared projections module across React, Vue and Svelte", () => {
  it("differs ONLY in the four declared leaf options", async () => {
    // #2366's claim, extended to its first follower and kept falsifiable: the
    // module stays ONE shared emitter widened by options, not a per-framework
    // seam.  Undo the four leaves and Svelte's output must be React's, byte
    // for byte.  If a later port ever needs more than a string substitution
    // here, THAT is the signal to fork (angular/feliz/flutter) rather than
    // grow this list — see the decision comment at the head of the module.
    const svelte = (await files()).get("src/lib/api/projections.ts")!;
    const react = (await files(SRC.replace("platform: svelte", "platform: react")))!.get(
      "src/api/projections.ts",
    )!;
    const undone = svelte
      .replace("@tanstack/svelte-query", "@tanstack/react-query")
      .replace("import { createQuery }", "import { useQuery }")
      .replace(`from "../schemas"`, `from "../lib/schemas"`)
      .replace("return createQuery(() => ({", "return useQuery({")
      .replace("  }));", "  });");
    expect(undone).toBe(react);
  });
});
