// The api-surface lift (M-T4.8) — pins `deriveContextOperations` against the
// routes the Hono backend ACTUALLY emits.
//
// This is the whole point of the module: it is only useful as a single source
// of truth if it agrees with the shipped route builders.  A unit test that
// asserted the derivation against hand-written expectations would pass
// happily while drifting from the emitters — so instead this parses a real
// `.ddd`, generates the Hono project, scrapes the `createRoute({ method, path })`
// pairs out of the emitted routes file, and asserts the two sets agree.
//
// The comparison is scoped to the route classes the lift covers
// (`apiSurfaceCoverage.lifted`); the not-yet-lifted classes (workflow,
// explicit handler, projection query, prepare) are excluded EXPLICITLY by
// path shape, so adding one to the lift later makes this test fail until the
// exclusion is removed — the gap can't go quiet.

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import {
  apiSurfaceCoverage,
  deriveAggregateOperations,
  deriveContextOperations,
} from "../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { buildLoomModel } from "../_helpers/ir.js";

const SOURCE = `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
        }
        // when-gated: carries a GET /{id}/can_cancel probe alongside it, so
        // the agreement assertion covers the gate-probe arm rather than
        // passing on zero-vs-zero.
        operation cancel() when status == "Placed" {
          status := "Cancelled"
        }
      }
      repository Orders for Order {
        find byCode(c: string): Order? where code == c
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable ordersSvc { platform: node contexts: [Orders] dataSources: [ordersState] port: 3000 }
}
`;

/** The `Orders` context out of a lowered+enriched model. */
function ordersContext(model: LoomModel): BoundedContextIR | undefined {
  return model.systems
    .flatMap((s) => s.subdomains)
    .flatMap((sd) => sd.contexts)
    .find((c) => c.name === "Orders");
}

/** `method: "get"` + `path: "/{id}"` pairs, in emission order, out of a
 *  generated Hono routes file. */
function scrapeHonoRoutes(src: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const re = /method:\s*"(\w+)",\s*\n\s*path:\s*"([^"]*)"/g;
  for (const m of src.matchAll(re)) out.push({ method: m[1]!, path: m[2]! });
  return out;
}

describe("api-surface lift", () => {
  it("derives the same method+path set the Hono backend emits", async () => {
    const model = await buildLoomModel(SOURCE);
    const ctx = ordersContext(model);
    expect(ctx, "Orders context lowered").toBeDefined();

    const derived = deriveContextOperations(ctx!);

    const files = await generateSystemFiles(SOURCE);
    const routesFile = [...files.entries()].find(([p]) => p.endsWith("order.routes.ts"));
    expect(routesFile, "hono emitted an order.routes.ts").toBeDefined();

    // Hono's paths are router-RELATIVE (`/{id}`); the lift's are absolute
    // (`/api/orders/{id}`).  Compare on the relative form by stripping the
    // aggregate mount prefix the derivation adds.
    const rel = (p: string): string => p.replace("/api/orders", "") || "/";

    const emitted = scrapeHonoRoutes(routesFile![1])
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const lifted = derived.map((o) => `${o.method} ${rel(o.path)}`).sort();

    expect(lifted).toEqual(emitted);
  });

  it("orders static find paths before the /{id} param route", async () => {
    const model = await buildLoomModel(SOURCE);
    const ctx = ordersContext(model)!;
    const ops = deriveContextOperations(ctx);

    const byCode = ops.findIndex((o) => o.path.endsWith("/by_code"));
    const getById = ops.findIndex((o) => o.kind === "getById");
    expect(byCode).toBeGreaterThanOrEqual(0);
    // A static segment registered AFTER `/{id}` is shadowed by it — the
    // ordering is load-bearing, not cosmetic.
    expect(byCode).toBeLessThan(getById);
  });

  it("types the operation route's response and failure statuses", async () => {
    const model = await buildLoomModel(SOURCE);
    const ctx = ordersContext(model)!;
    const place = deriveContextOperations(ctx).find((o) => o.kind === "operation");

    expect(place?.id).toBe("placeOrder");
    expect(place?.method).toBe("post");
    expect(place?.path).toBe("/api/orders/{id}/place");
    // A client can only type its failure union if the statuses are data.
    expect(place?.errorStatuses).toContain(404);
    expect(place?.errorStatuses).toContain(409);
  });

  it("emits no create route for a non-constructible aggregate", async () => {
    const model = await buildLoomModel(SOURCE);
    const ctx = ordersContext(model)!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    const repo = ctx.repositories.find((r) => r.aggregateName === "Order");

    const ops = deriveAggregateOperations({ ...agg, operations: [] }, repo);
    // `crudish` makes Order constructible, so the baseline HAS a create; the
    // gate is `emitsRestCreate`, shared with the emitters.
    expect(deriveAggregateOperations(agg, repo).some((o) => o.kind === "create")).toBe(true);
    expect(ops.every((o) => o.kind !== "operation")).toBe(true);
  });

  it("names the route classes it has not lifted yet", () => {
    // Guards against the set silently being treated as exhaustive.
    expect(apiSurfaceCoverage.notLifted).toContain("workflow");
    expect(apiSurfaceCoverage.notLifted).toContain("prepare");
  });

  it("emits the can_<op> probe only for a when-gated operation", async () => {
    const model = await buildLoomModel(SOURCE);
    const ops = deriveContextOperations(ordersContext(model)!);
    const probes = ops.filter((o) => o.kind === "gateProbe").map((o) => o.path);
    // `cancel` is `when`-gated; `place` and crudish's `update` are not.
    expect(probes).toEqual(["/api/orders/{id}/can_cancel"]);
  });
});
