// The `requires` gate on a FOLDED (materialized) projection, on all five
// backends — the read-model half of the projection gate.
//
// A folded projection is a physical table of rows served at
// `GET /projections/<p>` and `GET /projections/<p>/{key}`.  Those are ordinary
// client-reachable read endpoints, so they take the same 403-before-read gate a
// query-time projection takes.
//
// Until this landed they could not: the gate lived inside the query-clause
// fragment of the grammar, so a folded projection (no `from`, hence no
// query-clause tail) had nowhere to put the keyword, and a validator
// (`loom.projection-gate-without-source`) rejected the combination with a
// message asserting that a folded projection "has nothing to protect".  It
// protects a table.  The gate moved to the declaration header, the five read
// emitters learned to emit it, and that validator is gone.
//
// Both routes are pinned, and the ORDER matters on the by-key one: the gate has
// to run before the lookup, or a caller who fails it still learns whether the
// key exists.
//
// The ungated control is pinned too — without it, emitting the gate
// unconditionally would satisfy every positive assertion.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const system = (platform: string, gate: string) => `system Shop {
  user { id: string role: string }
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id  code: string }
      projection OrderBook keyed by order ${gate}{
        order: Order id
        code: string
        on(e: OrderPlaced) { order := e.order  code := e.code }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: ${platform} contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 auth: required }
}`;

const GATE = 'requires currentUser.role == "admin" ';

async function fileEndingWith(platform: string, gate: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(system(platform, gate));
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix} (platform ${platform})`);
}

/** Per backend: the read-model routes file, the emitted 403 guard, and — per
 *  route — where that route's handler starts and the read it performs.  Each
 *  assertion is scoped to the slice starting at `at`, so an anchor can't be
 *  satisfied by an identical-looking string in a sibling helper (node's
 *  `loadOrderBook` runs the very same drizzle select the by-key route does). */
const BACKENDS = [
  {
    name: "node",
    file: "http/projections.ts",
    guard:
      'if (!(currentUser.role === "admin")) throw new ForbiddenError("Forbidden: projection OrderBook");',
    list: { at: 'operationId: "listOrderBook"', read: "db.select().from(schema.orderBooks);" },
    byKey: {
      at: 'const { key } = httpCtx.req.valid("param");',
      read: "db.select().from(schema.orderBooks).where(",
    },
  },
  {
    name: "dotnet",
    file: "OrdersProjectionsController.cs",
    guard:
      'if (!(currentUser.Role == "admin")) throw new ForbiddenException("Forbidden: projection OrderBook");',
    list: {
      at: "public async Task<IActionResult> ListOrderBook()",
      read: "AsNoTracking().ToListAsync()",
    },
    byKey: {
      at: "public async Task<IActionResult> GetOrderBook(",
      read: "FirstOrDefaultAsync(",
    },
  },
  {
    name: "java",
    file: "OrdersProjectionsController.java",
    guard:
      'if (!(Objects.equals(currentUser.role(), "admin"))) throw new ForbiddenException("Forbidden: projection OrderBook");',
    list: { at: "public List<OrderBookResponse> listOrderBook()", read: ".findAll()" },
    byKey: {
      at: "public ResponseEntity<OrderBookResponse> getOrderBook(",
      read: ".findById(",
    },
  },
  {
    name: "python",
    file: "http/projections_routes.py",
    guard: 'raise ForbiddenError("Forbidden: projection OrderBook")',
    list: { at: "async def order_book_list(", read: "session.execute(select(OrderBookRow))" },
    byKey: { at: "async def order_book_get(", read: "session.get(OrderBookRow, key)" },
  },
  {
    name: "elixir",
    file: "controllers/projections_controller.ex",
    guard: '"Forbidden: projection OrderBook"',
    list: { at: "def order_book_index(", read: "Repo.all(" },
    byKey: { at: "def order_book_show(", read: "Repo.get(" },
  },
] as const;

describe("folded projection `requires` gate", () => {
  for (const b of BACKENDS) {
    it(`${b.name}: gates BOTH read-model routes, each before its read`, async () => {
      const out = await fileEndingWith(b.name, GATE, b.file);
      // Two guards — one per route.  A single occurrence would mean one route
      // is open, which is the same hole with half the surface.
      const occurrences = out.split(b.guard).length - 1;
      expect(occurrences, `expected 2 gates on ${b.name}, got ${occurrences}`).toBe(2);
      for (const route of [b.list, b.byKey]) {
        const start = out.indexOf(route.at);
        expect(start, `handler '${route.at}' not found on ${b.name}`).toBeGreaterThan(-1);
        const body = out.slice(start);
        const gateAt = body.indexOf(b.guard);
        const readAt = body.indexOf(route.read);
        expect(gateAt, `no gate in '${route.at}' on ${b.name}`).toBeGreaterThan(-1);
        expect(readAt, `no read in '${route.at}' on ${b.name}`).toBeGreaterThan(-1);
        // The whole point: on the by-key route a gate that ran after the lookup
        // would let a denied caller distinguish "forbidden" from "no such key".
        expect(readAt).toBeGreaterThan(gateAt);
      }
    });
  }

  for (const b of BACKENDS) {
    it(`${b.name}: an UNGATED folded projection emits no gate`, async () => {
      const out = await fileEndingWith(b.name, "", b.file);
      expect(out).not.toContain("Forbidden: projection OrderBook");
      expect(out).not.toContain('"admin"');
    });
  }

  it("the gate is declared in the response set, not just enforced", async () => {
    // The three backends that publish per-route response schemas from this
    // emitter declare the 403 alongside the guard, so a generated client does
    // not have to treat its own callee's authorization denial as an unexpected
    // throw.  (java/elixir publish their contract elsewhere.)
    expect(await fileEndingWith("node", GATE, "http/projections.ts")).toContain(
      '403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemDetails } } },',
    );
    expect(await fileEndingWith("dotnet", GATE, "OrdersProjectionsController.cs")).toContain(
      "[ProducesResponseType(typeof(ProblemDetails), 403)]",
    );
    expect(await fileEndingWith("python", GATE, "http/projections_routes.py")).toContain(
      '403: {"model": ProblemDetails, "description": "Forbidden"}',
    );
  });
});

describe("the folded-projection router answers a missing key as 404", () => {
  // Regression, found while adding the 403 arm.  `projectionsRoutes` was the
  // one emitted hono sub-router with NO `app.onError`, and `app.route()` runs a
  // mounted handler under the SUB-app's error handler — so the
  // `AggregateNotFoundError` this route throws escaped into hono's default
  // handler and came back as a text/plain 500.  Every other backend answered
  // 404 (`NotFound()` / `ResponseEntity.notFound()` / `not_found_response` /
  // an explicit raise), so node alone reported a missing projection key as a
  // server fault.
  it("node maps AggregateNotFoundError to 404 in the router's own onError", async () => {
    const out = await fileEndingWith("node", "", "http/projections.ts");
    expect(out).toContain("app.onError((err, c) => {");
    expect(out).toContain(
      'if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);',
    );
    // …and the handler is registered INSIDE projectionsRoutes, not on the
    // parent app (where it would never see this router's throws).
    const routerAt = out.indexOf("export function projectionsRoutes(");
    expect(out.indexOf("app.onError")).toBeGreaterThan(routerAt);
  });
});
