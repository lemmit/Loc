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

// A handler with a value-object body param — the request body schema references
// `<Vo>Schema`, which must be declared in-scope or the generated project fails
// `tsc --noEmit` (TS2304: Cannot find name 'MoneySchema').
const VO_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      valueobject Money { amount: int; currency: string }
      aggregate Order ids guid {
        code: string
        total: Money
        operation applyDiscount(amount: Money, reason: string) { }
      }
      repository Orders for Order { }
      commandHandler Discount(orderId: Order id, amount: Money, reason: string): Order id {
        let o = Orders.getById(orderId)
        o.applyDiscount(amount, reason)
        return o.id
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/discounts" -> Ordering.Discount
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

// C2 (the Hono sibling of the .NET C1 in #1830): a handler that returns a
// domain aggregate projects it to its wire shape via the owning repo's
// `toWire(...)` — reusing the repo the query already built — so the route
// serialises the contract, not the raw domain entity.
const AGG_RETURN_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        code: string
        status: string
        operation cancel() { status := "cancelled" }
      }
      repository Orders for Order { }
      queryHandler GetOrder(orderId: Order id): Order {
        let o = Orders.getById(orderId)
        return o
      }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/{orderId}" -> Ordering.GetOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("hono — explicit handler returning a domain aggregate", () => {
  it("projects the returned aggregate through the loaded repo's toWire(...)", async () => {
    const router = fileEndingWith(
      await generateSystemFiles(AGG_RETURN_SRC),
      "http/salesApi-routes.ts",
    );
    // repo built once for the load and reused for the projection.
    expect(router).toContain("const orders = new OrderRepository(db, events);");
    expect(router).toContain("const o = await orders.getById(orderId);");
    // the return wraps the domain entity in `toWire`, not a raw `as unknown` cast.
    expect(router).toContain("return httpCtx.json(orders.toWire(o), 200);");
    expect(router).not.toContain("return httpCtx.json(o as unknown, 200);");
    expect(router).not.toContain("__bad__");
  });
});

// An `extern` handler is bodyless: the route still wires up, but instead of a
// rendered load→mutate→save body it calls a scaffold-once, user-owned impl
// module (`src/application/<kebab>-handler-impl.ts`).
const EXTERN_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order { code: string }
      repository Orders for Order { }
      extern commandHandler PlaceOrder(code: string): Order id;
      extern queryHandler GetQuote(orderId: Order id): string;
    }
  }
  api SalesApi from Sales {
    route POST "/orders" -> Ordering.PlaceOrder
    route GET  "/orders/{orderId}/quote" -> Ordering.GetQuote
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("hono — extern commandHandler / queryHandler", () => {
  it("route dispatch calls the scaffold-once impl and returns its value", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const router = fileEndingWith(m, "http/salesApi-routes.ts");
    // Imports + calls the user impl module (not an inline repo/workflow body).
    expect(router).toContain(
      'import { placeOrderImpl } from "../application/place-order-handler-impl";',
    );
    expect(router).toContain("const result = await placeOrderImpl(code);");
    expect(router).toContain("return httpCtx.json(result as unknown, 200);");
    expect(router).not.toContain("new OrderRepository(");
    // The extern query dispatches likewise (path-coerced id passed through).
    expect(router).toContain("const result = await getQuoteImpl(orderId);");
  });

  it("emits a scaffold-once impl stub that throws loudly", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const impl = fileEndingWith(m, "application/place-order-handler-impl.ts");
    expect(impl.split("\n")[0]).toContain("loom:scaffold-once");
    expect(impl).toContain(
      "export async function placeOrderImpl(code: string): Promise<Ids.OrderId>",
    );
    expect(impl).toContain("throw new ExternHandlerError(");
    expect(impl).toContain("is not implemented");
  });
});

describe("hono — explicit handler with a value-object body param", () => {
  it("declares the VO wire schema in-scope so the body schema resolves", async () => {
    const router = fileEndingWith(await generateSystemFiles(VO_SRC), "http/salesApi-routes.ts");
    // The body schema references the VO schema by name (path id split out).
    expect(router).toContain(
      'params: z.object({ orderId: z.string().uuid() }), body: { content: { "application/json": { schema: z.object({ amount: MoneySchema, reason: z.string() }) } } }',
    );
    // …and that name is actually in scope — declared in the file (or imported),
    // not a dangling reference that tsc rejects with TS2304.
    const declared =
      /\bconst\s+MoneySchema\s*=/.test(router) ||
      /import\b[^;]*\bMoneySchema\b[^;]*from/.test(router);
    expect(declared, "MoneySchema referenced but never declared/imported").toBe(true);
    // The VO is still constructed from the validated body (runtime coercion).
    expect(router).toContain("const amount = new Money(body.amount.amount, body.amount.currency);");
  });
});

// A commandHandler that hard-deletes via `<Repo>.delete(o)` — the repo-delete
// handler statement.  The generated Hono repository's `delete(id)` takes the
// aggregate's ID token, so the emitted call appends `.id` to the loaded entity.
const DELETE_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order ids guid {
        status: string
        destroy { }
      }
      repository Orders for Order { }
      commandHandler DestroyOrder(orderId: Order id) {
        let o = Orders.getById(orderId)
        Orders.delete(o)
      }
    }
  }
  api SalesApi from Sales {
    route DELETE "/orders/{orderId}" -> Ordering.DestroyOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("hono — explicit handler repo-delete (destroy)", () => {
  it("renders `<Repo>.delete(o.id)` (id arg) on a DELETE route", async () => {
    const router = fileEndingWith(await generateSystemFiles(DELETE_SRC), "http/salesApi-routes.ts");
    expect(router).toContain('method: "delete"');
    // load by id, then delete — the generated repo `delete(id)` takes the id token.
    expect(router).toContain("const o = await orders.getById(orderId);");
    expect(router).toContain("await orders.delete(o.id);");
    // NOT the whole aggregate (that's the .NET/Java shape).
    expect(router).not.toContain("await orders.delete(o);");
  });
});
