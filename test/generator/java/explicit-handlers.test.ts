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
