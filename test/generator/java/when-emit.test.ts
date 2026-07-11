// The `when` canCommand state gate on the Java/Spring Boot backend
// (criterion.md, use site 2) — the fifth and final backend to ship it, closing
// `loom.when-unsupported`.
//
// A `when`-gated operation loads the aggregate, evaluates the predicate over
// its current state (enum values → `<Enum>.<Value>`, read through the entity's
// record-style accessors), and throws DisallowedException — mapped by
// ApiExceptionAdvice to a 409 ProblemDetail — before mutating.  It also
// auto-exposes a side-effect-free `GET /<plural>/{id}/can_<op>` returning the
// shared `CanResponse { allowed }` record.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft, Shipped, Cancelled }
      aggregate Order {
        code: string
        status: OrderStatus
        operation cancel() when this.status != Shipped && this.status != Cancelled {
          status := Cancelled
        }
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8080
  }
}
`;

async function gen(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC))).files;
}

function find(files: Map<string, string>, pred: (k: string) => boolean, label: string): string {
  const key = [...files.keys()].find(pred);
  expect(key, `${label} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("Java `when` gate + can-query", () => {
  it("gates the operation: loads the aggregate, throws DisallowedException before mutating", async () => {
    const svc = find(await gen(), (k) => k.endsWith("OrderService.java"), "service");
    expect(svc).toContain("var aggregate = repository.getById(id);");
    // Enum values resolve to `<Enum>.<Value>`, read through record accessors.
    expect(svc).toContain(
      "if (!(aggregate.status() != OrderStatus.Shipped && aggregate.status() != OrderStatus.Cancelled)) throw new DisallowedException(",
    );
    // The gate precedes the mutation.
    const gateAt = svc.indexOf("throw new DisallowedException");
    const callAt = svc.indexOf("aggregate.cancel(");
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(callAt);
  });

  it("emits the side-effect-free can<Op> service method returning the predicate", async () => {
    const svc = find(await gen(), (k) => k.endsWith("OrderService.java"), "service");
    expect(svc).toContain("public boolean canCancel(OrderId id) {");
    expect(svc).toContain(
      "return aggregate.status() != OrderStatus.Shipped && aggregate.status() != OrderStatus.Cancelled;",
    );
  });

  it("auto-exposes GET can_<op> returning CanResponse { allowed }", async () => {
    const ctrl = find(await gen(), (k) => k.endsWith("OrdersController.java"), "controller");
    expect(ctrl).toContain('@GetMapping("/{id}/can_cancel")');
    expect(ctrl).toContain("public CanResponse canCancelOrder(@PathVariable UUID id) {");
    expect(ctrl).toContain("return new CanResponse(service.canCancel(new OrderId(id)));");
  });

  it("emits the CanResponse record and DisallowedException, and maps it to 409", async () => {
    const files = await gen();
    const can = find(files, (k) => k.endsWith("CanResponse.java"), "CanResponse");
    expect(can).toContain("public record CanResponse(boolean allowed)");
    const exc = find(files, (k) => k.endsWith("DisallowedException.java"), "DisallowedException");
    expect(exc).toContain("public class DisallowedException extends RuntimeException");
    const advice = find(files, (k) => k.endsWith("ApiExceptionAdvice.java"), "advice");
    expect(advice).toContain("@ExceptionHandler(DisallowedException.class)");
    expect(advice).toContain('problem(409, "Disallowed", e.getMessage(), request), 409');
  });
});
