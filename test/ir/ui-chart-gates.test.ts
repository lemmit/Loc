// The `Chart` honest gates (M-T1.3 Phase 4) — a chart the target can't render
// or an arg shape the walker can't key on is a COMPILE ERROR, not a blank or
// permanently-empty chart.
//
// Two gate families, mirroring the DataGrid/projection-read split:
//
//   - `loom.chart-unsupported-target` (system-checks.ts) — per-PACK, not
//     per-framework: `Chart` renders through the active pack's
//     `primitive-chart` template + a pack-specific chart dependency, and only
//     react + mantine@v9 (the lead pack) ships both today.
//   - `loom.chart-of-not-grouped` / `-kind-invalid` / `-accessor-not-field`
//     (ui-checks.ts) — the arg shapes: `of:` must name a readable GROUPED
//     projection (a singleton has one object — nothing to plot), `kind:` is
//     the closed "line" | "bar" set, and `x:`/`y:` must be simple accessor
//     lambdas naming declared row fields.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { CHART_FRAMEWORKS } from "../../src/ir/validate/checks/system-checks.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/index.js";

async function diagsOf(src: string) {
  return validateLoomModel(enrichLoomModel(lowerModel(await parseValid(src))));
}

/** `platform:` for a ui's host — same rule as the DataGrid gate tests. */
const hostFor = (framework: string): string =>
  framework === "feliz" || framework === "flutter" ? framework : "static";

/** One system, parameterised by ui framework / deployable design / chart args.
 *  Ships BOTH a grouped and a singleton projection so each case picks its
 *  `of:` target. */
const sys = (opts: { framework?: string; design?: string; chart?: string }): string => `
system S {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order { code: string  total: money  status: OrderStatus  derived display: string = code }
      repository Orders for Order { }
      projection SalesByStatus {
        status: OrderStatus  revenue: money
        from Order as o
        group by o.status
        select status = o.status, revenue = sum(o.total)
      }
      projection SalesTotals {
        orders: int
        from Order as o
        select orders = count()
      }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp {
    ${opts.framework ? `framework: ${opts.framework}` : ""}
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        ${opts.chart ?? `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`}
      }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: ${hostFor(opts.framework ?? "react")} targets: api ui: WebApp { Sales: api } port: 3000${opts.design ? ` design: ${opts.design}` : ""} }
}
`;

describe("loom.chart-unsupported-target (per-pack gate)", () => {
  // EVERY shipping frontend renders a chart now, so there is no framework left
  // to assert a rejection on — and that is exactly when a gate stops being
  // checkable from the outside: "the check works" and "the check is
  // unreachable" look identical.  The honest test is therefore to REMOVE a
  // framework from the Set and watch the diagnostic come back, which is the
  // discipline `PROJECTION_READ_FRAMEWORKS` already uses one gate over.
  it("still fires for a framework without a chart renderer", async () => {
    CHART_FRAMEWORKS.delete("angular");
    try {
      const diags = await diagsOf(sys({ framework: "angular" }));
      const hit = diags.find((d) => d.code === "loom.chart-unsupported-target");
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("error");
      // The message must point at the alternative that actually works.
      expect(hit?.message).toContain("Table");
    } finally {
      CHART_FRAMEWORKS.add("angular");
    }
  });

  for (const framework of ["vue", "svelte", "angular"]) {
    it(`accepts Chart on a ${framework} frontend`, async () => {
      const diags = await diagsOf(sys({ framework }));
      expect(diags.find((d) => d.code === "loom.chart-unsupported-target")).toBeUndefined();
    });
  }

  // The pack backfill is complete (M-T1.3 Phase 5): every tsx pack emits
  // `primitive-chart`, so the gate collapsed from a per-PACK set to the same
  // per-FRAMEWORK rule `DataGrid` uses.  A missing template is now a pack-LOAD
  // failure via `REQUIRED_PRIMITIVES.tsx.core`, not something re-checked here.
  // Barewords resolve to each family's LATEST pack; the `@vN` pins cover the
  // older majors, which bind different chart-library versions (x-charts v7 vs
  // v8, tailwind v3's `hsl(var(--token))` vs v4's `var(--token)`).  A pinned
  // spelling is a STRING in the grammar, so it is quoted here.
  for (const design of [
    "shadcn",
    "mui",
    "chakra",
    `"shadcn@v3"`,
    `"mui@v5"`,
    `"chakra@v2"`,
    `"mantine@v7"`,
  ]) {
    it(`accepts Chart on react with the ${design} design pack`, async () => {
      const diags = await diagsOf(sys({ design }));
      expect(diags.filter((d) => d.code?.startsWith("loom.chart-"))).toEqual([]);
    });
  }

  it("accepts Chart on react with the default design (mantine@v9)", async () => {
    const diags = await diagsOf(sys({}));
    expect(diags.filter((d) => d.code?.startsWith("loom.chart-"))).toEqual([]);
  });

  it("accepts Chart on react with an explicit mantine pin", async () => {
    const diags = await diagsOf(sys({ design: "mantine" }));
    expect(diags.filter((d) => d.code?.startsWith("loom.chart-"))).toEqual([]);
  });
});

describe("Chart arg gates (ui-checks.ts)", () => {
  it("rejects of: a SINGLETON projection — one object has nothing to plot", async () => {
    const diags = await diagsOf(
      sys({
        chart: `Chart { kind: "bar", of: Sales.SalesTotals, x: r => r.status, y: r => r.revenue }`,
      }),
    );
    const hit = diags.find((d) => d.code === "loom.chart-of-not-grouped");
    expect(hit).toBeDefined();
    // The fix hint names the missing clause.
    expect(hit?.message).toContain("group by");
  });

  it("rejects of: an unknown name", async () => {
    const diags = await diagsOf(
      sys({
        chart: `Chart { kind: "bar", of: Sales.Nonexistent, x: r => r.status, y: r => r.revenue }`,
      }),
    );
    expect(diags.find((d) => d.code === "loom.chart-of-not-grouped")).toBeDefined();
  });

  it("rejects a kind outside line|bar", async () => {
    const diags = await diagsOf(
      sys({
        chart: `Chart { kind: "pie", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`,
      }),
    );
    const hit = diags.find((d) => d.code === "loom.chart-kind-invalid");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('"line" or "bar"');
  });

  it("rejects a computed x: lambda — no field name to key the axis on", async () => {
    const diags = await diagsOf(
      sys({
        chart: `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.revenue + r.revenue, y: r => r.revenue }`,
      }),
    );
    expect(diags.find((d) => d.code === "loom.chart-accessor-not-field")).toBeDefined();
  });

  it("rejects an accessor naming a field the projection doesn't declare", async () => {
    const diags = await diagsOf(
      sys({
        chart: `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.margin }`,
      }),
    );
    const hit = diags.find((d) => d.code === "loom.chart-accessor-not-field");
    expect(hit).toBeDefined();
    // The message lists the declared row fields.
    expect(hit?.message).toContain("'revenue'");
  });

  it("accepts the canonical grouped chart — no loom.chart-* diagnostics", async () => {
    const diags = await diagsOf(sys({}));
    expect(diags.filter((d) => d.code?.startsWith("loom.chart-"))).toEqual([]);
  });
});
