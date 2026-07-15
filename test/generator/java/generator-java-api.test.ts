// ---------------------------------------------------------------------------
// Java backend — API layer (slice S5 of
// docs/old/plans/java-backend-implementation.md): controllers (route shape =
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
      aggregate Order with crudish {
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
    expect(ctrl).toContain('@RequestMapping("/api/orders")');
    expect(ctrl).toContain("    @PostMapping");
    expect(ctrl).toContain('    @GetMapping("/{id}")');
    expect(ctrl).toContain("    @GetMapping");
    expect(ctrl).toContain('    @PostMapping("/{id}/confirm")');
    expect(ctrl).toContain('    @PostMapping("/{id}/add_item")');
    expect(ctrl).toContain('    @GetMapping("/by_code")');
  });

  it("create returns 201 `{ id }` with a Location header; ops return 204", async () => {
    const ctrl = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain('ResponseEntity.created(URI.create("/api/orders/" + id.value()))');
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
      "public record OrderResponse(UUID id, String code, Status status, AddressResponse shipTo, String notes, String total, String placedAt, int version, List<LineItemResponse> lineItems, String lineTotal) {",
    );
    expect(dto).toContain("value.total().toPlainString()");
    expect(dto).toContain("value.placedAt().toString()");
    expect(dto).toContain("value.lineItems().stream().map(LineItemResponse::from).toList()");
  });

  it("response record excludes internal + secret fields (forApiRead parity)", async () => {
    // softDeletable's `isDeleted` is `internal`, `apiKey` is `secret` — no
    // backend serves either on a read; the record must decide visibility
    // exactly like Hono's zod response / .NET's DTO (caught live by
    // conformance-parity as `SquadResponse: only-java=[isDeleted]`).
    const src = `
system S {
  subdomain Core {
    context C {
      aggregate Squad with crudish, softDeletable {
        name: string
        apiKey: string secret
      }
      repository Squads for Squad { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource cs { for: C, kind: state, use: pg }
  deployable api { platform: java contexts: [C] serves: A dataSources: [cs] port: 8080 }
}`;
    const out = await generateSystemFiles(src);
    const key = [...out.keys()].find((k) => k.endsWith("SquadResponse.java"))!;
    const dto = out.get(key)!;
    expect(dto).not.toContain("isDeleted");
    expect(dto).not.toContain("apiKey");
    // managed (deletedAt) and declared fields stay on the wire.
    expect(dto).toContain("deletedAt");
    expect(dto).toContain("String name");
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

describe("java generator — paged finds", () => {
  const PAGED_SRC = SRC.replace(
    "find byCode(code: string): Order[] where this.code == code",
    "find byCode(code: string): Order[] where this.code == code\n        find recent(): Order paged",
  );

  it("emits the Paged<T> envelope, Pageable repository path, and the paged route", async () => {
    const f = await generateSystemFiles(PAGED_SRC);
    expect(f.get(`${ROOT}/domain/common/Paged.java`)).toContain(
      "public record Paged<T>(List<T> items, int page, int pageSize, int total, int totalPages) {",
    );
    const port = f.get(`${ROOT}/features/orders/OrderRepository.java`)!;
    expect(port).toContain("Paged<Order> recent(int page, int pageSize, String sort, String dir);");
    const jpa = f.get(`${ROOT}/features/orders/OrderJpaRepository.java`)!;
    expect(jpa).toContain("Page<Order> recent(Pageable pageable);");
    const impl = f.get(`${ROOT}/features/orders/OrderRepositoryImpl.java`)!;
    // Server-side sort (M-T2.6): a whitelisted Sort built into the PageRequest.
    expect(impl).toContain("var result = jpa.recent(PageRequest.of(page - 1, pageSize, __sort));");
    expect(impl).toContain(
      'Sort __sort = Sort.by("desc".equals(dir) ? Sort.Direction.DESC : Sort.Direction.ASC, __sortField);',
    );
    expect(impl).toContain(
      "return new Paged<>(result.getContent(), page, pageSize, (int) result.getTotalElements(), result.getTotalPages());",
    );
    const ctrl = f.get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain(
      'public Paged<OrderResponse> recentOrder(@RequestParam(defaultValue = "1") int page, @RequestParam(defaultValue = "20") int pageSize, @RequestParam(defaultValue = "id") String sort, @RequestParam(defaultValue = "asc") String dir) {',
    );
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

  it("mirrors create wire constraints onto the crudish update validator (SYS-1)", async () => {
    // M-T6.8/SYS-1: the crudish `update` op's validator carries the SAME
    // field-invariant checks as `create`, so an invalid update throws
    // WireValidationException (422) instead of reaching the domain floor.
    const src = `
system Demo {
  subdomain S {
    context C {
      aggregate Account with crudish {
        handle: string
        invariant handle.length > 0
      }
      repository Accounts for Account { }
    }
  }
  api AccountApi from S
  storage primary { type: postgres }
  deployable api { platform: java contexts: [C] serves: AccountApi port: 8080 }
}
`;
    const out = await generateSystemFiles(src);
    const v = [...out.entries()].find(([k]) => /AccountValidators\.java$/.test(k))?.[1];
    expect(v).toBeDefined();
    const updateMethod = v!.slice(v!.indexOf("public static void update("));
    expect(v).toContain("public static void update(String handle)");
    expect(updateMethod).toContain(
      'if (!(handle.length() >= 1)) errors.add(WireValidationException.error("/handle", "Invariant violated: handle.length > 0"));',
    );
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

  it("advice logs the fault tier through CatalogLog with each fault's real status", async () => {
    // S1 parity: every fault handler emits its catalog event (warn) at the
    // real HTTP status, alongside the existing internal_error — matching
    // Hono/.NET/Python/vanilla so the log stream is uniform cross-backend.
    const advice = (await files()).get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(advice).toContain(
      'CatalogLog.event("domain_error", "warn", "message", "Validation failed", "status", 422);',
    );
    expect(advice).toContain(
      'CatalogLog.event("forbidden", "warn", "message", e.getMessage(), "status", 403);',
    );
    expect(advice).toContain(
      'CatalogLog.event("domain_error", "warn", "message", e.getMessage(), "status", 400);',
    );
    expect(advice).toContain(
      'CatalogLog.event("disallowed", "warn", "message", e.getMessage(), "status", 409);',
    );
    expect(advice).toContain('CatalogLog.event("not_found", "warn", "status", 404);');
  });

  it("the controller logs the S2 info narrative (aggregate_created + operation_invoked)", async () => {
    // S2 parity (domain-seam-log-parity.md): the create route emits
    // `aggregate_created` after persist; every op route emits `operation_invoked`
    // with aggregate/op/id — matching Hono/.NET so the narrative anchors faults.
    const ctrl = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain(
      'CatalogLog.event("aggregate_created", "info", "aggregate", "Order", "id", id.value());',
    );
    expect(ctrl).toContain(
      'CatalogLog.event("operation_invoked", "info", "aggregate", "Order", "op", "confirm", "id", id);',
    );
    expect(ctrl).toContain(
      'CatalogLog.event("operation_invoked", "info", "aggregate", "Order", "op", "addItem", "id", id);',
    );
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
