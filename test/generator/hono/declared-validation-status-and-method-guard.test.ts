// Two schemathesis root causes on the ROUTE boundary of the Hono emitter,
// gated structurally (the fuzzer that found them runs nightly).
//
// F6 — a route that PARSES a request part answers 422 on a parse failure, and
// until this gate only the BODY-carrying kinds said so.  `GET /<aggs>/{id}`
// published `[200, 404]`, `DELETE /<aggs>/{id}` published `[204, 404, 409]` and
// the paged collection GET published `[200]` alone, while every one of them
// answers 422 for a malformed `{id}` or an out-of-range `?page=`.  The fix is
// the shared matrix + `findValidatesRequest`, so the gate checks BOTH the
// positive (a validated route declares it) and the negative (a param-less,
// un-paged find parses nothing and declares nothing — the flag is derived from
// the route's shape, not stamped on the kind).
//
// F8 — a wrong verb on a STATIC sub-path was captured by the sibling `/{id}`
// route: `DELETE /api/orders/by_qty` matched `delete /{id}` with
// `id = "by_qty"` and the param validator answered `422 Invalid UUID` for a
// path that has no DELETE at all.  The discrimination has to run BEFORE that
// validator, so it is a router-level middleware — and it has to be registered
// under hono's `ALL` method, or the root router's `allowedFor` probe (which
// skips `ALL`) would start counting it and change `app.notFound`'s answers.
//
// Register: docs/audits/schemathesis-findings-2026-08.md (F6, F8).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order with crudish {
        qty: int
        note: string
      }
      repository Orders for Order {
        find byQty(min: int): Order[]
        find recent(): Order[]
      }
      aggregate Tag with crudish {
        label: string
      }
      repository Tags for Tag { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
}
`;

/** The per-aggregate routers from one generation. */
async function routers(): Promise<{ order: string; tag: string }> {
  const files = await generateSystemFiles(SRC);
  const pick = (suffix: string): string => {
    const hit = [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];
    expect(hit, suffix).toBeDefined();
    return hit as string;
  };
  return { order: pick("http/order.routes.ts"), tag: pick("http/tag.routes.ts") };
}

/** One `app.openapi(createRoute({ … }))` block, sliced by its declared
 *  `method:` + `path:` pair.  Slicing to the NEXT `app.openapi(` keeps a
 *  `not.toContain` assertion meaningful — a whole-file search would read the
 *  neighbouring route's declarations as this one's. */
function routeBlock(src: string, method: string, path: string): string {
  const marker = `      method: "${method}",\n      path: "${path}",`;
  const start = src.indexOf(marker);
  expect(start, `${method.toUpperCase()} ${path} route`).toBeGreaterThan(-1);
  const next = src.indexOf("  app.openapi(", start);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("hono declared responses — 422 rides every parsed request part (F6)", () => {
  it("the by-id read and the destroy declare the 422 their param validator answers", async () => {
    const { order } = await routers();
    for (const [method, path] of [
      ["get", "/{id}"],
      ["delete", "/{id}"],
    ] as const) {
      const block = routeBlock(order, method, path);
      // The validator that PRODUCES the 422 …
      expect(block, `${method} ${path} parses {id}`).toContain(
        "request: { params: z.object({ id: z.string().uuid() }) },",
      );
      // … and the declaration that admits it.
      expect(block, `${method} ${path} declares 422`).toContain(
        '422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },',
      );
    }
  });

  it("a paged collection GET declares 422 — its page controls are parsed even with no declared params", async () => {
    const { order } = await routers();
    const all = routeBlock(order, "get", "/");
    expect(all).toContain("request: { query: AllQuery },");
    expect(all).toContain('422: { description: "Unprocessable Entity"');
    // The bound that produces it: `?page=0` is refused by the emitted min(1).
    expect(order).toContain("page: z.coerce.number().int().min(1)");
  });

  it("a find WITH params declares 422; a param-less, un-paged find declares none", async () => {
    const { order } = await routers();
    const byQty = routeBlock(order, "get", "/by_qty");
    expect(byQty).toContain("request: { query: ByQtyQuery },");
    expect(byQty).toContain('422: { description: "Unprocessable Entity"');
    // `find recent(): Order[]` parses NOTHING — no query object is even
    // emitted — so declaring a 422 there would be the inverse fault: a status
    // published on a route that cannot produce it.
    const recent = routeBlock(order, "get", "/recent");
    expect(recent, "an un-parsed find emits no request block").not.toContain("request:");
    expect(recent, "an un-parsed find declares no 422").not.toContain("422:");
  });
});

describe("hono static sub-paths — a wrong verb answers 405, not the {id} validator's 422 (F8)", () => {
  it("the guard is emitted, lists each static segment's real methods, and runs first", async () => {
    const { order } = await routers();
    expect(order).toContain(
      'const staticSubpathMethods: Record<string, string[]> = { by_qty: ["GET"], recent: ["GET"] };',
    );
    expect(order).toContain('app.use("/:__seg", async (c, next) => {');
    expect(order).toContain('allow: allow.join(", ")');
    expect(order).toContain("frameworkProblemBody(405,");
    // BEFORE the first route: the `@hono/zod-openapi` param validator runs
    // inside the matched route's own handler chain, so a guard registered after
    // `/{id}` has already lost — the 422 is on the wire.
    const guardAt = order.indexOf('app.use("/:__seg"');
    const firstRoute = order.indexOf("  app.openapi(");
    expect(firstRoute, "the router mounts at least one route").toBeGreaterThan(-1);
    expect(guardAt, "the guard must precede every route").toBeLessThan(firstRoute);
  });

  it("the guard is registered under method ALL, which the root probe skips", async () => {
    const { order } = await routers();
    // `app.use` (not `app.on`/`app.all` with named verbs): the root router's
    // `allowedFor` builds its 405 probe from `app.routes` and SKIPS `ALL`
    // entries, so registering named verbs here would silently change what
    // `app.notFound` reports for every path in this router.
    const from = order.indexOf("const staticSubpathMethods");
    // Anchored: without this, dropping the guard makes `slice(-1)` an empty
    // string and the `not.toMatch` below passes on nothing — a check that
    // never reaches the thing it names.
    expect(from, "the guard block must exist to be checked").toBeGreaterThan(-1);
    const guard = order.slice(from, order.indexOf("  app.openapi(", from));
    expect(guard).toContain("app.use(");
    expect(guard).not.toMatch(/app\.(all|on|delete|put|patch)\(/);
  });

  it("an aggregate with no static sub-path emits no guard — nothing to discriminate", async () => {
    const { tag } = await routers();
    expect(tag, "Tag has no named find and no prepare route").not.toContain("staticSubpathMethods");
    // …and it still gets the F6 declaration, so the two fixes are independent.
    expect(routeBlock(tag, "get", "/{id}")).toContain('422: { description: "Unprocessable Entity"');
  });
});
