// ---------------------------------------------------------------------------
// Java backend — API layer (slice S5 of
// docs/plans/java-backend-implementation.md): controllers (route shape =
// the cross-backend OpenAPI contract), DTO records in wireShape order
// with the money/datetime string wire convention, the layered service,
// wire validators (shared classifier → 422), and the RFC 7807 advice.
// The same fixture is exercised end-to-end against Postgres in the
// LOOM_JAVA_BUILD/manual smoke; these unit tests pin the emitted shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum Status { pending, confirmed }
      valueobject Address {
        city: string
        zip: string
      }
      aggregate Order {
        code: string
        status: Status
        shipTo: Address
        notes: string?
        total: money
        placedAt: datetime
        contains lineItems: LineItem[]
        entity LineItem {
          sku: string
          qty: int
          price: money
        }
        derived lineTotal: money = lineItems.sum(i => i.price)
        invariant code.length > 0
        operation confirm() {
          precondition status == pending
          status := confirmed
        }
        operation addItem(sku: string, qty: int, price: money) {
          precondition qty > 0
          lineItems += LineItem { sku: sku, qty: qty, price: price }
        }
      }
      repository Orders for Order {
        find byCode(code: string): Order[] where this.code == code
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable shopApi {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8081
  }
}
`;

const ROOT = "shop_api/src/main/java/com/loom/shopapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — controller routes (S5)", () => {
  it("emits the canonical route set on /<plural_snake>", async () => {
    const ctrl = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain('@RequestMapping("/orders")');
    expect(ctrl).toContain("    @PostMapping");
    expect(ctrl).toContain('    @GetMapping("/{id}")');
    expect(ctrl).toContain("    @GetMapping");
    expect(ctrl).toContain('    @PostMapping("/{id}/confirm")');
    expect(ctrl).toContain('    @PostMapping("/{id}/add_item")');
    expect(ctrl).toContain('    @GetMapping("/by_code")');
  });

  it("create returns 201 `{ id }` with a Location header; ops return 204", async () => {
    const ctrl = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain('ResponseEntity.created(URI.create("/orders/" + id.value()))');
    expect(ctrl).toContain(".body(new CreateOrderResponse(id.value()));");
    expect(ctrl).toContain("@ResponseStatus(HttpStatus.NO_CONTENT)");
  });

  it("getById maps a miss to a bare 404", async () => {
    const ctrl = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain(
      "return response == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(response);",
    );
  });
});

describe("java generator — DTO records (S5)", () => {
  it("response record follows wireShape order with money/datetime as strings", async () => {
    const dto = (await files()).get(`${ROOT}/features/orders/OrderResponse.java`)!;
    expect(dto).toContain(
      "public record OrderResponse(UUID id, String code, Status status, AddressResponse shipTo, String notes, String total, String placedAt, List<LineItemResponse> lineItems, String lineTotal) {",
    );
    expect(dto).toContain("value.total().toPlainString()");
    expect(dto).toContain("value.placedAt().toString()");
    expect(dto).toContain("value.lineItems().stream().map(LineItemResponse::from).toList()");
  });

  it("create request takes wire types; the service parses them to domain values", async () => {
    const files_ = await files();
    const req = files_.get(`${ROOT}/features/orders/CreateOrderRequest.java`)!;
    expect(req).toContain(
      "public record CreateOrderRequest(String code, Status status, AddressRequest shipTo, String notes, String total, String placedAt) {",
    );
    const svc = files_.get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain("var total = new BigDecimal(request.total());");
    expect(svc).toContain("var placedAt = Instant.parse(request.placedAt());");
    expect(svc).toContain("var shipTo = toAddress(request.shipTo());");
  });
});

describe("java generator — layered service (S5)", () => {
  it("create: parse → validate → domain factory → save → publish → id", async () => {
    const svc = (await files()).get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain("OrderValidators.create(code, status, shipTo, notes, total, placedAt);");
    expect(svc).toContain(
      "var aggregate = Order.create(code, status, shipTo, notes, total, placedAt);",
    );
    expect(svc).toContain("repository.save(aggregate);");
    expect(svc).toContain("publishEvents(aggregate);");
  });

  it("operations follow load-mutate-save", async () => {
    const svc = (await files()).get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain("var aggregate = repository.getById(id);");
    expect(svc).toContain("aggregate.addItem(sku, qty, price);");
  });
});

describe("java generator — wire validators + advice (S5)", () => {
  it("translates classified invariants into 422 checks via the shared classifier", async () => {
    const v = (await files()).get(`${ROOT}/features/orders/OrderValidators.java`)!;
    expect(v).toContain("public final class OrderValidators {");
    expect(v).toContain(
      'if (!(code.length() >= 1)) errors.add(WireValidationException.error("/code", "Invariant violated: code.length > 0"));',
    );
    expect(v).toContain("if (!errors.isEmpty()) throw new WireValidationException(errors);");
  });

  it("advice maps the exception taxonomy to the cross-backend problem envelope", async () => {
    const advice = (await files()).get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(advice).toContain("@RestControllerAdvice");
    expect(advice).toContain(
      'problem(422, "Validation failed", "One or more fields are invalid.", request)',
    );
    expect(advice).toContain('problem.setProperty("errors", e.errors().stream()');
    expect(advice).toContain('problem(403, "Forbidden", e.getMessage(), request), 403');
    expect(advice).toContain('problem(400, "Bad Request", e.getMessage(), request), 400');
    expect(advice).toContain('problem(404, "Not Found", e.getMessage(), request), 404');
  });

  it("serves the OpenAPI document at /openapi.json", async () => {
    const files_ = await files();
    expect(files_.get("shop_api/src/main/resources/application.yml")).toContain(
      "path: /openapi.json",
    );
    expect(files_.get("shop_api/build.gradle.kts")).toContain(
      "org.springdoc:springdoc-openapi-starter-webmvc-ui",
    );
  });
});
