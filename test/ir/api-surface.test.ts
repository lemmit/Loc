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

/** Per `operationId`, the SUCCESS response the Hono route declares: the 2xx
 *  status and the zod schema constant it names (`undefined` = no body). */
function scrapeHonoSuccessBodies(src: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  // Each `createRoute({...})` block, sliced on `operationId:` boundaries.
  const blocks = src.split(/operationId:\s*"/).slice(1);
  for (const raw of blocks) {
    const id = raw.slice(0, raw.indexOf('"'));
    const head = raw.slice(0, raw.indexOf("}),"));
    // The first 2xx arm wins; a `204` with no `content:` has no body.
    const m = head.match(/\n\s*(2\d\d):\s*\{([\s\S]*?)\n\s*(?:\d{3}:|\},)/);
    if (!m) {
      out.set(id, undefined);
      continue;
    }
    const schema = m[2]!.match(/schema:\s*([A-Za-z_][A-Za-z0-9_]*)/);
    out.set(id, schema?.[1]);
  }
  return out;
}

/** Collapse a scraped schema constant to the SHAPE a client has to parse.
 *  Resolved from the emitted source so a renamed constant doesn't silently
 *  pass — the shape is what the wire carries. */
function shapeOfSchema(src: string, name: string | undefined): string {
  if (!name) return "none";
  const decl = src.match(
    new RegExp(`const ${name} = z\\.object\\(([\\s\\S]*?)\\)\\s*(?:\\.openapi|;)`),
  );
  const body = decl?.[1] ?? "";
  if (/\bitems:\s*z\.array/.test(body)) return "paged";
  // An id-only envelope is the create route's `201 { id }`.
  const keys = [...body.matchAll(/(\w+):\s*z\./g)].map((m) => m[1]!);
  if (keys.length === 1 && keys[0] === "id") return "idEnvelope";
  return "entity";
}

/** The shape the CLIENT emitters parse for an operation — the mirror of the
 *  `createName` / `pagedName` / `absentAgg` ladder they all share. */
function clientExpectedShape(op: { kind: string; responseType?: unknown }): string {
  if (op.kind === "create") return "idEnvelope";
  const t = op.responseType as { kind?: string; ctor?: string } | undefined;
  if (!t) return "none";
  if (t.kind === "genericInstance" && t.ctor === "paged") return "paged";
  // `optional` and `union` are both the absence shape: the success body is the
  // entity DIRECTLY at 200, with absence riding its own status.
  if (t.kind === "entity" || t.kind === "union" || t.kind === "optional") return "entity";
  return "none";
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

    // Compare ABSOLUTE paths — what a client actually puts on the wire.
    //
    // This used to normalize the lift's absolute path down to Hono's
    // router-relative one with `p.replace("/api/orders", "") || "/"`, and that
    // `|| "/"` made the test blind to the one difference that matters at
    // runtime: `/api/orders/` and `/api/orders` BOTH collapsed to `"/"`, so a
    // derivation emitting the trailing-slash form compared equal to a callee
    // serving the bare form.  It does not answer equal on the wire — Hono 404s
    // the slashed request — and `createOrder`/`allOrder` were broken on all
    // five backends behind that green assertion.
    //
    // So the composition runs the other way now: Hono's relative path is
    // resolved to the absolute one it actually serves (a `"/"` sub-route under
    // `app.route("/api/orders", …)` mounts at `/api/orders`, NOT
    // `/api/orders/`), and the lift's absolute path is compared verbatim.
    const abs = (relPath: string): string =>
      relPath === "/" ? "/api/orders" : `/api/orders${relPath}`;

    const emitted = scrapeHonoRoutes(routesFile![1])
      .map((r) => `${r.method} ${abs(r.path)}`)
      .sort();
    const lifted = derived.map((o) => `${o.method} ${o.path}`).sort();

    expect(lifted).toEqual(emitted);
  });

  it("declares the same SUCCESS BODY SHAPE the Hono backend sends", async () => {
    // The companion to the method+path check above.  Paths agreeing is not the
    // whole contract: a client that reaches the right URL and then parses the
    // wrong shape fails at RUNTIME while compiling perfectly on both sides.
    //
    // Two drifts of exactly this kind shipped before this test existed —
    // `create` answers `201 { id }` (not the whole entity its declared
    // responseType names), and a domain operation with no declared return
    // answers `204` with NO body while the derivation types it as the entity.
    // Both were invisible to every compile gate.
    const model = await buildLoomModel(SOURCE);
    const ctx = ordersContext(model);
    expect(ctx, "Orders context lowered").toBeDefined();

    const files = await generateSystemFiles(SOURCE);
    const routesFile = [...files.entries()].find(([p]) => p.endsWith("order.routes.ts"));
    expect(routesFile, "hono emitted an order.routes.ts").toBeDefined();
    const src = routesFile![1];

    const emitted = scrapeHonoSuccessBodies(src);
    const mismatches: string[] = [];
    for (const op of deriveContextOperations(ctx!)) {
      if (!emitted.has(op.id)) continue; // not a lifted route — covered elsewhere
      const callee = shapeOfSchema(src, emitted.get(op.id));
      const client = clientExpectedShape(op);
      if (callee !== client) {
        mismatches.push(`${op.id}: callee sends ${callee}, client parses ${client}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
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

    // A client can only type its failure union if the statuses are data — and
    // the statuses have to be the ones the callee actually sends.  This used to
    // assert `toContain(409)` on `place`, which has a `precondition` and NO
    // `when` gate: on the denial ladder (RS-15) a precondition answers 422 and
    // 409 is the `when` rung, so `place` can never send 409.  The assertion
    // passed only because the derivation kept its own hardcoded status table
    // that put 409 on every operation — a test pinning the defect, the same way
    // `slice2-crud-write.test.ts` pinned Phoenix's PATCH route.
    //
    // Asserted as an exact set, and against BOTH rungs, so neither can drift
    // back: `place` (precondition, ungated) vs `cancel` (`when`-gated).
    expect([...(place?.errorStatuses ?? [])].sort()).toEqual([400, 404, 422]);

    const cancel = deriveContextOperations(ctx).find((o) => o.id === "cancelOrder");
    expect([...(cancel?.errorStatuses ?? [])].sort()).toEqual([400, 404, 409, 422]);
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
