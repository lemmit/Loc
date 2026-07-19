// Java / Spring emission for the explicit application/transport layer
// (unfoldable-api-derivation.md, A2 — the Java sibling of the .NET A1 test):
// `commandHandler` / `queryHandler` context members + `route <M> "<path>" ->
// <Ctx>.<Handler>` api bindings emit onto the plain repository seam — a
// `@Service` handler bean per member (no mediator, no marker records) and one
// `@RestController` per served api that coerces wire path params into the
// domain types and calls the bean directly.  Real `gradle` compilation is
// deferred to the LOOM_JAVA_BUILD gate.
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
  deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
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

describe("java — explicit commandHandler/queryHandler → @Service beans", () => {
  it("emits the command handler bean: injected repo, rendered body, exit-save, return", async () => {
    const h = fileEndingWith(await files(), "CancelOrderHandler.java");
    expect(h).toContain("@Service");
    expect(h).toContain("@Transactional");
    expect(h).toContain("public class CancelOrderHandler {");
    // constructor-injected repository field.
    expect(h).toContain("private final OrderRepository ordersRepository;");
    // domain-typed method param — no command-param rewrite; bare param ref.
    expect(h).toContain("public OrderId handle(OrderId orderId) {");
    expect(h).toContain("var o = ordersRepository.getById(orderId);");
    expect(h).toContain("o.cancel();");
    expect(h).toContain("ordersRepository.save(o);");
    // record-style accessor on the return.
    expect(h).toContain("return o.id();");
    expect(h).not.toContain("__bad__");
  });

  it("emits the query handler bean returning the resolved value (read-only, no __bad__)", async () => {
    const h = fileEndingWith(await files(), "GetStatusHandler.java");
    expect(h).toContain("public class GetStatusHandler {");
    expect(h).toContain("@Transactional(readOnly = true)");
    expect(h).toContain("public String handle(OrderId orderId) {");
    expect(h).toContain("var o = ordersRepository.getById(orderId);");
    expect(h).toContain("return o.status();");
    expect(h).not.toContain("__bad__");
  });

  it("emits one @RestController per api dispatching each route to its handler bean", async () => {
    const ctrl = fileEndingWith(await files(), "SalesApiRoutesController.java");
    expect(ctrl).toContain("@RestController");
    expect(ctrl).toContain("public class SalesApiRoutesController {");
    // handler beans are constructor-injected.
    expect(ctrl).toContain("private final CancelOrderHandler cancelOrderHandler;");
    expect(ctrl).toContain("private final GetStatusHandler getStatusHandler;");
    // command route: POST + wire-coerced id path param → new OrderId(...) → 200.
    expect(ctrl).toContain('@PostMapping("/orders/{orderId}/cancellations")');
    expect(ctrl).toContain("public ResponseEntity<?> cancelOrder(@PathVariable UUID orderId) {");
    expect(ctrl).toContain("var result = cancelOrderHandler.handle(new OrderId(orderId));");
    expect(ctrl).toContain("return ResponseEntity.ok(result);");
    // query route: GET + wire-coerced id path param.
    expect(ctrl).toContain('@GetMapping("/orders/{orderId}/status")');
    expect(ctrl).toContain("var result = getStatusHandler.handle(new OrderId(orderId));");
  });
});

// B2 (the Java slice of the [FromBody] fan-out; .NET landed as B1 #1822): a
// handler param NOT bound by a `{token}` in the route path rides in a
// `@RequestBody <Handler>Body` record, not a bogus `@PathVariable`.
const BODY_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      valueobject Money { amount: int; currency: string }
      aggregate Order ids guid {
        code: string
        status: string
        operation discount(amount: Money, reason: string) { status := "discounted" }
      }
      repository Orders for Order { }
      commandHandler Discount(orderId: Order id, amount: Money, reason: string): Order id {
        let o = Orders.getById(orderId)
        o.discount(amount, reason)
        return o.id
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/discounts" -> Ordering.Discount
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

// C2 (the Java slice of the aggregate-return response-DTO projection; .NET
// landed as C1 #1830): a handler that returns an aggregate/entity is projected
// to its wire-shape `<Agg>Response.from(result)` at the route boundary, not
// serialised as the raw JPA entity. Id / scalar / body returns stay as-is.
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
  deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("java — explicit handler aggregate return → wire-shape Response (C2)", () => {
  it("projects an aggregate return to <Agg>Response.from(result), not the raw entity", async () => {
    const ctrl = fileEndingWith(
      await generateSystemFiles(AGG_RETURN_SRC),
      "SalesApiRoutesController.java",
    );
    expect(ctrl).toContain('@GetMapping("/orders/{orderId}")');
    expect(ctrl).toContain("var result = getOrderHandler.handle(new OrderId(orderId));");
    // The domain Order is projected to its wire DTO — not serialised raw.
    expect(ctrl).toContain("return ResponseEntity.ok(OrderResponse.from(result));");
    expect(ctrl).not.toContain("return ResponseEntity.ok(result);");
    // The response DTO package is wildcard-imported so `OrderResponse` resolves
    // (byFeature default → `<base>.features.orders`).
    expect(ctrl).toContain(".features.orders.*;");
  });

  it("leaves an id / scalar return unprojected (ResponseEntity.ok(result))", async () => {
    const m = await files();
    const ctrl = fileEndingWith(m, "SalesApiRoutesController.java");
    // CancelOrder returns `Order id` and GetStatus returns `string` — neither is
    // an entity, so both stay bare `ResponseEntity.ok(result)`.
    expect(ctrl).toContain("return ResponseEntity.ok(result);");
    expect(ctrl).not.toContain("Response.from(result)");
  });
});

describe("java — explicit route params: {token} → @PathVariable, rest → @RequestBody record", () => {
  it("splits path vs body params: unbound complex params ride in one @RequestBody record", async () => {
    const ctrl = fileEndingWith(
      await generateSystemFiles(BODY_SRC),
      "SalesApiRoutesController.java",
    );
    // The body record is co-located with the controller (package-private).
    expect(ctrl).toContain("record DiscountBody(Money amount, String reason) {}");
    // Only the {orderId} token stays a @PathVariable; amount/reason ride the body.
    expect(ctrl).toContain(
      "public ResponseEntity<?> discount(@PathVariable UUID orderId, @RequestBody DiscountBody body) {",
    );
    // Declared param order preserved in the handler call: path coercion, then
    // the record accessors.
    expect(ctrl).toContain(
      "var result = discountHandler.handle(new OrderId(orderId), body.amount(), body.reason());",
    );
    // Nothing bogus: amount/reason are never emitted as @PathVariable.
    expect(ctrl).not.toContain("@PathVariable Money");
    expect(ctrl).not.toContain("@PathVariable String reason");
    // The value-object package is imported so the body record resolves Money.
    expect(ctrl).toContain("import ");
  });
});

// An `extern` handler is bodyless: the generated dispatch delegates to a
// scaffold-once, user-owned impl the user fills in (extern-handler Phase 1).
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
  deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;
// M-T5.10 handler-param rewrite: a scaffolded handler takes a single
// `command`/`query` RECORD param.  On Java the `@Service handle(...)` FLATTENS
// the record's fields (byte-identical to the flat-param form) and `cmd.<field>`
// reads the flattened flat param; a read declares `<Agg>Response` but the
// handler still returns the ENTITY (the controller projects at the boundary).
const SCAFFOLD_SRC = `
system Shop {
  subdomain Sales {
    context Ordering with scaffoldHandlers {
      valueobject Money { amount: decimal; currency: string }
      aggregate Order {
        code: string
        status: string
        total: Money
        create(code: string) { code := code  status := "new"  total := Money { amount: 0, currency: "USD" } }
        operation setNote(note: string) { status := note }
        operation reprice(newTotal: Money) { total := newTotal }
        operation cancel() { status := "cancelled" }
        destroy { }
      }
      repository Orders for Order {
        find byStatus(status: string): Order[] where this.status == status
      }
    }
  }
  api SalesApi with scaffoldApi(of: Sales)
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: java, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("java — scaffolded handlers consume command/query record params", () => {
  it("flattens a command record into the handle() signature + body record and reads the flat field", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    // Create: the command record's fields flatten into the handle() params, and
    // `cmd.<field>` reads them bare (no `cmd.code()` accessor).
    const createH = fileEndingWith(m, "CreateOrderHandler.java");
    expect(createH).toContain("public OrderId handle(String code, String status, Money total) {");
    expect(createH).toContain("var o = Order.create(code, status, total);");
    expect(createH).not.toContain("cmd.");
    // Operation: the id stays a flat param, the op's params ride the record.
    const setNoteH = fileEndingWith(m, "SetNoteOrderHandler.java");
    expect(setNoteH).toContain("public void handle(OrderId orderId, String note) {");
    expect(setNoteH).toContain("o.setNote(note);");
    expect(setNoteH).not.toContain("cmd.");
  });

  it("a read declares <Agg>Response but the handler returns the entity", async () => {
    const m = await generateSystemFiles(SCAFFOLD_SRC);
    // getById: the internal handle() types on the entity (not OrderResponse).
    const getH = fileEndingWith(m, "GetOrderHandler.java");
    expect(getH).toContain("public Order handle(OrderId orderId) {");
    expect(getH).toContain("return o;");
    expect(getH).not.toContain("OrderResponse");
    // find: a collection read types on List<Order>, returns the raw list.
    const byStatusH = fileEndingWith(m, "ByStatusOrderHandler.java");
    expect(byStatusH).toContain("public List<Order> handle(String status) {");
    expect(byStatusH).toContain("var r = ordersRepository.byStatus(status);");
    expect(byStatusH).toContain("return r;");
    expect(byStatusH).not.toContain("OrderResponse");
  });

  it("the controller reads the record's fields + projects the response at the boundary", async () => {
    const ctrl = fileEndingWith(
      await generateSystemFiles(SCAFFOLD_SRC),
      "SalesApiRoutesController.java",
    );
    // Body records carry the flattened fields, byte-identical to the flat form.
    expect(ctrl).toContain("record CreateOrderBody(String code, String status, Money total) {}");
    expect(ctrl).toContain("@RequestBody CreateOrderBody body");
    // Command call args read the flattened fields off the body record.
    expect(ctrl).toContain(
      "var result = createOrderHandler.handle(body.code(), body.status(), body.total());",
    );
    expect(ctrl).toContain("setNoteOrderHandler.handle(new OrderId(orderId), body.note());");
    // getById projects the entity to its wire DTO at the boundary.
    expect(ctrl).toContain("return ResponseEntity.ok(OrderResponse.from(result));");
    // find projects EACH element of the collection.
    expect(ctrl).toContain(
      "return ResponseEntity.ok(result.stream().map(OrderResponse::from).toList());",
    );
  });
});

describe("java — extern commandHandler / queryHandler", () => {
  it("the @Service handler ctor-injects the port and delegates", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const handler = fileEndingWith(m, "PlaceOrderHandler.java");
    expect(handler).toContain("private final PlaceOrderPort placeOrderPort;");
    expect(handler).toContain("return placeOrderPort.handle(code);");
    // The port interface is generated alongside.
    const port = fileEndingWith(m, "PlaceOrderPort.java");
    expect(port).toContain("public interface PlaceOrderPort {");
    expect(port).toContain("OrderId handle(String code);");
  });

  it("emits a scaffold-once @Service impl that throws", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const impl = fileEndingWith(m, "PlaceOrderHandlerImpl.java");
    expect(impl.split("\n")[0]).toContain("loom:scaffold-once");
    expect(impl).toContain("public class PlaceOrderHandlerImpl implements PlaceOrderPort");
    expect(impl).toContain("throw new UnsupportedOperationException(");
  });
});

// paged-run queryHandler (`queryHandler H(...): <Agg> paged { let r =
// Repo.run(<Criterion>(args)); return r }`) → a `@Service` bean over the
// synthesized paged FIND repo method + a GET action with page/pageSize/sort/dir
// @RequestParams returning the wire-projected `Paged<Agg>Response` envelope.
const PAGED_SRC = `
system S {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  region: string }
      repository Orders for Order { }
      criterion InRegion(rgn: string) of Order = region == rgn
      queryHandler ListInRegion(rgn: string): Order paged {
        let r = Orders.run(InRegion(rgn))
        return r
      }
    }
  }
  api A from Sales { route GET "/orders/projections/in_region" -> Orders.ListInRegion }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: java, contexts: [Orders], dataSources: [s], serves: A, port: 5001 }
}
`;
describe("java — paged-run queryHandler over run(criterion)", () => {
  it("the handler bean delegates to the synthesized paged FIND repo method", async () => {
    const h = fileEndingWith(await generateSystemFiles(PAGED_SRC), "ListInRegionHandler.java");
    expect(h).toContain(
      "public Paged<Order> handle(String rgn, int page, int pageSize, String sort, String dir)",
    );
    expect(h).toContain(
      "return ordersRepository.findAllByInRegion(rgn, page, pageSize, sort, dir);",
    );
  });

  it("the controller action exposes page/pageSize/sort/dir and returns the projected envelope", async () => {
    const ctrl = fileEndingWith(await generateSystemFiles(PAGED_SRC), "ARoutesController.java");
    expect(ctrl).toContain('@GetMapping("/orders/projections/in_region")');
    expect(ctrl).toContain('@RequestParam(defaultValue = "1") int page');
    expect(ctrl).toContain(
      "var result = listInRegionHandler.handle(rgn, page, pageSize, sort, dir);",
    );
    expect(ctrl).toContain("new Paged<>(result.items().stream().map(OrderResponse::from).toList()");
  });

  it("the aggregate controller does NOT auto-expose the synthesized find", async () => {
    const m = await generateSystemFiles(PAGED_SRC);
    const key = [...m.keys()].find((k) => k.endsWith("OrderController.java"));
    if (key) expect(m.get(key)!).not.toContain("in_region");
  });
});
