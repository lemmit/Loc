// ---------------------------------------------------------------------------
// `_frontend/projections-module.ts` — `readableProjections` (WHICH projections
// get a client) and `buildProjectionsApiModule` (the client itself), shared by
// the React / Vue / Svelte hosts through its four leaf options.
//
// Already pinned elsewhere, not repeated here:
//   * `react/projection-read{,-grouped}.test.ts`, `vue/projection-read.test.ts`,
//     `svelte/projection-read.test.ts` — per-framework: the module is emitted,
//     the row schema mirrors `wireShape`, the read binds single-record, and the
//     three leaf options differ by exactly the declared spellings.
//     `angular/projection-read.test.ts` pins its FORKED emitter against the
//     shared readability predicate.
//
// What none of them state is the SELECTION property over a model carrying more
// than one flavour of projection.  Each of those files generates a system whose
// only projection is the readable one under test, so "excludes the unreadable"
// is never actually exercised: a `readableProjections` that returned everything
// would pass all of them.  That is the emission this module is here to prevent
// — a client hook for a route shape that does not exist, whose `.parse` throws
// on first load from a model with no diagnostic at all.
//
// So this file builds ONE model carrying every flavour side by side and asserts
// the partition, then the per-readable-projection emission (one hook, one
// route, the right response shape) over that same model.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildProjectionsApiModule,
  readableProjections,
} from "../../../src/generator/_frontend/projections-module.js";
import type { BoundedContextIR } from "../../../src/ir/types/loom-ir.js";
import { isQueryTimeProjection, isSingletonProjection } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";

// One context, five projections — every flavour the predicate must sort:
//
//   SalesTotals   query-time, unkeyed, aggregated  → READABLE, one object
//   SalesByStatus query-time, unkeyed, `group by`  → READABLE, array of rows
//   BigOrders     query-time shorthand (no fields) → READABLE, array of rows
//   OrderBook     FOLDED (has `on` handlers)       → not readable (materialized)
//   PerStatus     folded AND `keyed by`            → not readable (both reasons)
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
      event OrderPlaced { order: Order id  code: string }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed

      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        select orders = count, revenue = sum(o.total)
      }

      projection SalesByStatus {
        status: OrderStatus
        orders: int
        from Order as o
        group by o.status
        select status = o.status, orders = count()
      }

      projection BigOrders { from Order as o where Confirmed }

      projection OrderBook keyed by order {
        order: Order id
        code: string
        on(e: OrderPlaced) { order := e.order  code := e.code }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}
`;

async function ordersContext(): Promise<BoundedContextIR> {
  const model = await buildLoomModel(SRC);
  const ctx = model.systems[0]?.subdomains
    .flatMap((s) => s.contexts)
    .find((c) => c.name === "Orders");
  if (!ctx) throw new Error("fixture emitted no Orders context");
  return ctx;
}

describe("readableProjections — the partition, on a model carrying every flavour", () => {
  it("keeps only the query-time singletons; excludes the materialized / keyed", async () => {
    const ctx = await ordersContext();
    // Anti-vacuity: the fixture really does carry the unreadable ones.
    expect((ctx.projections ?? []).map((p) => p.name).sort()).toEqual([
      "BigOrders",
      "OrderBook",
      "SalesByStatus",
      "SalesTotals",
    ]);
    expect(readableProjections([ctx]).map(({ proj }) => proj.name)).toEqual([
      "SalesTotals",
      "SalesByStatus",
      "BigOrders",
    ]);
  });

  it("agrees with the shared predicate's two conditions, projection by projection", async () => {
    const ctx = await ordersContext();
    const readable = new Set(readableProjections([ctx]).map(({ proj }) => proj.name));
    for (const p of ctx.projections ?? []) {
      expect(readable.has(p.name), p.name).toBe(
        isQueryTimeProjection(p) && isSingletonProjection(p),
      );
    }
    // …and the two reasons are genuinely distinct in this fixture.
    const book = (ctx.projections ?? []).find((p) => p.name === "OrderBook")!;
    expect(isQueryTimeProjection(book)).toBe(false);
    expect(isSingletonProjection(book)).toBe(false);
  });

  it("keeps declaration order, and carries the owning context back with each", async () => {
    const ctx = await ordersContext();
    for (const row of readableProjections([ctx])) expect(row.ctx).toBe(ctx);
    expect(readableProjections([])).toEqual([]);
    expect(readableProjections([{ ...ctx, projections: [] }])).toEqual([]);
  });
});

describe("buildProjectionsApiModule — one hook per readable projection", () => {
  it("emits exactly one exported hook per readable projection, and none for the rest", async () => {
    const module = buildProjectionsApiModule([await ordersContext()]);
    const hooks = [...module.matchAll(/^export function (use\w+)\(\)/gm)].map((m) => m[1]);
    expect(hooks).toEqual(["useSalesTotals", "useSalesByStatus", "useBigOrders"]);
    expect(module).not.toContain("OrderBook");
  });

  it("hits `/projections/<snake_name>` with no argument, keyed the same way", async () => {
    const module = buildProjectionsApiModule([await ordersContext()]);
    expect(module).toContain('queryKey: ["projections", "sales_totals"]');
    expect(module).toContain("await api.get(`/projections/sales_totals`)");
    expect(module).toContain('queryKey: ["projections", "sales_by_status"]');
    expect(module).toContain("await api.get(`/projections/sales_by_status`)");
    // The route slug is the SNAKE name, not the declared PascalCase one — a
    // hook that fetched `/projections/SalesTotals` 404s at runtime with a
    // green build.
    expect(module).not.toContain("/projections/SalesTotals");
  });

  it("wraps a LIST-shaped read in z.array and leaves the aggregation a bare object", async () => {
    const module = buildProjectionsApiModule([await ordersContext()]);
    // Whole-table aggregation → one object.
    expect(module).toContain("export const SalesTotalsResponse = z.object({");
    expect(module).not.toContain("export const SalesTotalsRow");
    // `group by` → a row schema plus an array response.
    expect(module).toContain("export const SalesByStatusRow = z.object({");
    expect(module).toContain("export const SalesByStatusResponse = z.array(SalesByStatusRow);");
    // Shorthand → also the list shape (the trap `projectionReadShape` exists
    // for: it is unkeyed, so "is it grouped?" answers wrongly here).
    expect(module).toContain("export const BigOrdersResponse = z.array(BigOrdersRow);");
  });

  it("parses the response at the boundary, per hook", async () => {
    const module = buildProjectionsApiModule([await ordersContext()]);
    for (const name of ["SalesTotals", "SalesByStatus", "BigOrders"]) {
      expect(module).toContain(`return ${name}Response.parse(r);`);
    }
  });

  it("renders an enum row field inline, since the <Enum>Schema consts live elsewhere", async () => {
    const module = buildProjectionsApiModule([await ordersContext()]);
    expect(module).toContain('status: z.enum(["Draft", "Confirmed"])');
  });

  it("imports moneySchema only because a row actually carries money", async () => {
    const ctx = await ordersContext();
    expect(buildProjectionsApiModule([ctx])).toContain(
      'import { moneySchema } from "../lib/schemas";',
    );
    expect(buildProjectionsApiModule([ctx])).toContain("revenue: moneySchema,");
  });

  it("emits the import block and nothing else for a context with no readable projection", async () => {
    const ctx = await ordersContext();
    const bare = buildProjectionsApiModule([
      { ...ctx, projections: (ctx.projections ?? []).filter((p) => p.name === "OrderBook") },
    ]);
    expect(bare).not.toContain("export function use");
    expect(bare).not.toContain("z.object({");
  });

  it("the leaf options substitute, and change nothing else", async () => {
    // The decision recorded at the top of the module: every divergence is a
    // STRING substituted into otherwise identical output.  Stated as a diff of
    // exactly the substituted lines, so a future option that reshapes the
    // output rather than substituting into it fails here.
    const ctx = await ordersContext();
    const react = buildProjectionsApiModule([ctx]);
    const svelte = buildProjectionsApiModule([ctx], {
      queryPackage: "@tanstack/svelte-query",
      queryFactory: "createQuery",
      thunkOptions: true,
      schemasImport: "../schemas",
    });
    expect(svelte).toContain('import { createQuery } from "@tanstack/svelte-query";');
    expect(svelte).toContain('import { moneySchema } from "../schemas";');
    expect(svelte).toContain("return createQuery(() => ({");
    expect(svelte).toContain("  }));");
    const normalize = (s: string) =>
      s
        .replace(/@tanstack\/\w+-query/g, "@tanstack/Q-query")
        .replace(/\b(useQuery|createQuery)\b/g, "QF")
        .replace(/\bQF\(\(\) => \(\{/g, "QF({")
        .replace(/^ {2}\}\)\);$/gm, "  });")
        .replace(/from "\.\.?\/[\w./]*schemas"/g, 'from "SCHEMAS"');
    expect(normalize(svelte)).toBe(normalize(react));
  });
});
