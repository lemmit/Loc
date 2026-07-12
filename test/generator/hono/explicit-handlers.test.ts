// Hono/TS emission for the explicit application/transport layer
// (unfoldable-api-derivation.md, A2 — the Hono sibling of the .NET A1 emitter):
// `commandHandler` / `queryHandler` context members + `route <M> "<path>" ->
// <Ctx>.<Handler>` api bindings emit one `app.openapi(createRoute({...}), ...)`
// route per binding in a per-served-api router (`http/<api>-routes.ts`),
// mounted in the http index.  Hono has no mediator, so each handler's logic is
// emitted directly into its route (no ICommand/IQuery record files like .NET).
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order ids guid {
        code: string
        status: string
        operation cancel() { status := "cancelled" }
      }
      repository Orders for Order { }
      commandHandler CancelOrder(orderId: Order id): Order id {
        let o = Orders.getById(orderId)
        o.cancel()
        return o.id
      }
      queryHandler GetStatus(orderId: Order id): string {
        let o = Orders.getById(orderId)
        return o.status
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/cancellations" -> Ordering.CancelOrder
    route GET  "/orders/{orderId}/status"        -> Ordering.GetStatus
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

describe("hono — explicit commandHandler/queryHandler → app.openapi routes", () => {
  it("emits a per-api router file with one openapi route per binding", async () => {
    const router = fileEndingWith(await files(), "http/salesApi-routes.ts");
    expect(router).toContain("export function salesApiRoutes(");
    expect(router).toContain("): OpenAPIHono {");
    expect(router).toContain("const app = newApp();");
    // command route: POST at the declared path.
    expect(router).toContain(
      'app.openapi(\n    createRoute({\n      method: "post",\n      path: "/orders/{orderId}/cancellations"',
    );
    // query route: GET at the declared path.
    expect(router).toContain('method: "get",');
    expect(router).toContain('path: "/orders/{orderId}/status"');
  });

  it("renders the command body: path-id coercion, inline repo, load, mutate, save, return", async () => {
    const router = fileEndingWith(await files(), "http/salesApi-routes.ts");
    // wire-coerced path id → domain id local.
    expect(router).toContain('const params = httpCtx.req.valid("param");');
    expect(router).toContain("const orderId = Ids.OrderId(params.orderId);");
    // repo constructed inline, not injected.
    expect(router).toContain("const orders = new OrderRepository(db, events);");
    // getById (throws → 404 via onError, no explicit guard), mutate, save.
    expect(router).toContain("const o = await orders.getById(orderId);");
    expect(router).toContain("o.cancel();");
    expect(router).toContain("await orders.save(o);");
    // returns the resolved value.
    expect(router).toContain("return httpCtx.json(o.id as unknown, 200);");
    expect(router).not.toContain("__bad__");
  });

  it("renders the query body returning the resolved value (no save, no __bad__)", async () => {
    const router = fileEndingWith(await files(), "http/salesApi-routes.ts");
    expect(router).toContain("return httpCtx.json(o.status as unknown, 200);");
    expect(router).not.toContain("__bad__");
  });

  it("wires an RFC7807 onError responder into the router", async () => {
    const router = fileEndingWith(await files(), "http/salesApi-routes.ts");
    expect(router).toContain("app.onError((err, c) => {");
    expect(router).toContain(
      'if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);',
    );
  });

  it("mounts the router in the http index under the API base", async () => {
    const idx = fileEndingWith(await files(), "http/index.ts");
    expect(idx).toContain('import { salesApiRoutes } from "./salesApi-routes";');
    expect(idx).toContain('app.route("/api", salesApiRoutes(db, events));');
  });
});
