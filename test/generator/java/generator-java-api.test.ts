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

  // RS-27 — this test used to be named "getById maps a miss to a bare 404" and
  // pinned `ResponseEntity.notFound().build()`.  That WAS the bug: Spring's own
  // bare 404 carries an EMPTY BODY and never reaches the
  // `@ExceptionHandler(AggregateNotFoundException)` arm in the
  // `@RestControllerAdvice`, so this one route answered a different envelope
  // from every other 404 in the same service — which the behavioural-java leg
  // read as `golden {…RFC-9457…} ≠ java ""`.  The assertion is INVERTED rather
  // than deleted so the old contract stays visible as the thing that changed.
  // (docs/conformance-semantics.md § RS-27.)
  it("getById maps a miss to the shared ProblemDetails 404, not a bare one", async () => {
    const ctrl = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain("return ResponseEntity.ok(service.getOrderById(new OrderId(id)));");
    expect(ctrl).not.toContain("ResponseEntity.notFound().build()");
    // The service is what raises it, so the read no longer answers `null`.
    const svc = (await files()).get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain(
      '.orElseThrow(() -> new AggregateNotFoundException("Order " + id + " not found"));',
    );
  });
});

describe("java generator — DTO records (S5)", () => {
  it("response record follows wireShape order with money/datetime as strings", async () => {
    const dto = (await files()).get(`${ROOT}/features/orders/OrderResponse.java`)!;
    expect(dto).toContain(
      "public record OrderResponse(UUID id, String code, Status status, AddressResponse shipTo, String notes, String total, String placedAt, int version, List<LineItemResponse> lineItems, String lineTotal) {",
    );
    // Money → wire string at the FIXED NUMERIC(19,4) scale (RS-12).
    expect(dto).toContain(
      "value.total().setScale(4, java.math.RoundingMode.HALF_UP).toPlainString()",
    );
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
    // The request record is plain wire types (money/datetime as String);
    // validation lives in a Spring Validator, not on the DTO.
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
  it("create: parse → domain factory → save → publish → id", async () => {
    const svc = (await files()).get(`${ROOT}/features/orders/OrderService.java`)!;
    // Validation lives in the CreateOrderValidator (run at `@Valid`), so the
    // service no longer calls a validator at the floor — parse → factory → save.
    expect(svc).not.toContain("Validator");
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
      'public Paged<OrderResponse> recentOrder(@RequestParam(defaultValue = "1") @jakarta.validation.constraints.Min(1) @jakarta.validation.constraints.Max(1000000) int page, @RequestParam(defaultValue = "20") @jakarta.validation.constraints.Min(1) @jakarta.validation.constraints.Max(500) int pageSize, @RequestParam(defaultValue = "id") String sort, @RequestParam(defaultValue = "asc") String dir) {',
    );
  });
});

describe("java generator — wire validators + advice (S5)", () => {
  it("emits a unified Spring Validator per command, run at the @Valid seam", async () => {
    // A classified invariant (`code.length > 0`) becomes an
    // `errors.rejectValue(...)` in a per-command Spring `Validator` — the .NET
    // FluentValidation analog (one validator, all rules, one seam).  The
    // controller registers it via `@InitBinder`; `@Valid @RequestBody` triggers
    // it; MethodArgumentNotValidException maps to the 422 envelope.
    const files_ = await files();
    const v = files_.get(`${ROOT}/features/orders/CreateOrderValidator.java`)!;
    expect(v).toContain("public final class CreateOrderValidator implements Validator {");
    expect(v).toContain("return CreateOrderRequest.class.equals(clazz);");
    expect(v).toContain(
      'if (!(((int) code.codePoints().count()) >= 1)) errors.rejectValue("code", "loom.invariant", "Invariant violated: code.length > 0");',
    );
    const ctrl = files_.get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(ctrl).toContain("@Valid @RequestBody CreateOrderRequest request");
    expect(ctrl).toContain("import jakarta.validation.Valid;");
    expect(ctrl).toContain("@InitBinder");
    expect(ctrl).toContain(
      "if (target instanceof CreateOrderRequest) binder.addValidators(new CreateOrderValidator());",
    );
    const advice = files_.get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(advice).toContain("@ExceptionHandler(MethodArgumentNotValidException.class)");
    // The pointer is built by `pointerOf` since the RFC-6901 fix — a nested
    // path is `/lineTotals/0/unitPrice`, not `/lineTotals[0].unitPrice`.
    expect(advice).toContain('entry.put("pointer", pointerOf(err.getField()));');
    expect(advice).toContain(
      'if (code != null && code.startsWith("msg.")) entry.put("code", code);',
    );
  });

  it("mirrors create wire constraints onto the crudish update validator (SYS-1)", async () => {
    // M-T6.8/SYS-1: the crudish `update` command's validator carries the SAME
    // field constraints as create, so an invalid update is rejected at the
    // `@Valid` boundary (422) instead of reaching the domain floor.
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
  resource cState { for: C, kind: state, use: primary }
  deployable api { platform: java contexts: [C] dataSources: [cState] serves: AccountApi port: 8080 }
}
`;
    const out = await generateSystemFiles(src);
    const check =
      'if (!(((int) handle.codePoints().count()) >= 1)) errors.rejectValue("handle", "loom.invariant", "Invariant violated: handle.length > 0");';
    const create = [...out.entries()].find(([k]) => /CreateAccountValidator\.java$/.test(k))?.[1];
    const update = [...out.entries()].find(([k]) => /UpdateAccountValidator\.java$/.test(k))?.[1];
    expect(create).toContain(check);
    expect(update).toContain(check);
  });

  it("advice maps the exception taxonomy to the cross-backend problem envelope", async () => {
    const advice = (await files()).get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(advice).toContain("@RestControllerAdvice");
    expect(advice).toContain(
      'problem(422, "Validation failed", "One or more fields are invalid.", request)',
    );
    expect(advice).toContain(
      'problem.setProperty("errors", e.getBindingResult().getFieldErrors().stream()',
    );
    expect(advice).toContain('problem(403, "Forbidden", e.getMessage(), request), 403');
    expect(advice).toContain('problem(422, "Unprocessable Entity", e.getMessage(), request), 422');
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
      'CatalogLog.event("domain_error", "warn", "message", e.getMessage(), "status", 422);',
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

// ---------------------------------------------------------------------------
// RS-22/RS-27 — a FIND-ABSENCE 404 goes through the shared producer.
//
// Both arms below used to answer `ResponseEntity.notFound().build()` — Spring's
// own bare 404 with an EMPTY BODY, which never reaches the
// `@RestControllerAdvice` and therefore carries none of the five RFC-9457
// members RS-22 requires on ANY error response.  It is the identical defect
// RS-27 fixed on the by-id read, at the two route arms that read `null` and
// answered locally instead of throwing.
//
// It also made ONE controller emit two different wires for shapes
// `docs/payloads.md` declares wire-identical: a union find with a declared
// `error` variant built a real ProblemDetail, while the `T option` / `T?` finds
// beside it built nothing.
//
// Found by the caller census drain (2026-08-05): `maybeFirst` (option) and
// `byEmail` (optional) got their first-ever callers and the java behavioural
// leg read `golden {…} ≠ java ""` on both.
// ---------------------------------------------------------------------------

const ABSENCE_SRC = `
system Abs {
  subdomain S {
    context C {
      error Missing { resource: string }
      aggregate Order with crudish { code: string }
      repository Orders for Order {
        find optionFind(code: string): Order option where this.code == code
        find nullableFind(code: string): Order? where this.code == code
        find errorFind(code: string): Order or Missing where this.code == code
        find listFind(code: string): Order[] where this.code == code
      }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  deployable api { platform: java contexts: [C] dataSources: [cState] serves: A port: 8080 }
}
`;

describe("java generator — find-absence 404 (RS-22/RS-27)", () => {
  it("throws through the shared producer for BOTH the `option` and the `?` find", async () => {
    const files_ = await generateSystemFiles(ABSENCE_SRC);
    const ctrl = files_.get(
      "api/src/main/java/com/loom/api/features/orders/OrdersController.java",
    )!;
    expect(ctrl, "the controller must be emitted for the premise to hold").toBeDefined();

    // Premise: all four find shapes really are in this controller, so the
    // assertions below are about the ABSENCE arm and not about a find the
    // emitter dropped.
    for (const route of ["/option_find", "/nullable_find", "/error_find", "/list_find"]) {
      expect(ctrl).toContain(`@GetMapping("${route}")`);
    }

    // `T option` and `T?` — the two shapes that answered an empty body.
    expect(ctrl).toContain('throw new AggregateNotFoundException("not_found");');
    expect(ctrl.match(/throw new AggregateNotFoundException\("not_found"\);/g)?.length).toBe(2);
    // …and the import that makes it compile.
    expect(ctrl).toContain("import com.loom.api.domain.common.AggregateNotFoundException;");

    // NOT the bare Spring 404, anywhere in the controller.  This is the exact
    // line the defect was: `ResponseEntity.notFound().build()` bypasses the
    // advice, so it can never carry the RS-22 envelope.
    expect(ctrl).not.toContain("ResponseEntity.notFound().build()");

    // The declared-`error` variant keeps its own mapped status + `resource`
    // extension (RS-19) — this fix must not collapse the two absence classes
    // into one.
    expect(ctrl).toContain('problem.setProperty("resource", "Order");');
  });

  it("routes that throw reach the advice's five-member envelope", async () => {
    // The other half of the contract: the producer the throw lands in really
    // does build the RS-22 envelope, so the two assertions compose into "the
    // find-absence 404 carries type/title/status/detail/instance".
    const files_ = await generateSystemFiles(ABSENCE_SRC);
    const advice = files_.get("api/src/main/java/com/loom/api/api/ApiExceptionAdvice.java")!;
    expect(advice).toContain("@ExceptionHandler(AggregateNotFoundException.class)");
    expect(advice).toContain(
      'return respond(problem(404, "Not Found", e.getMessage(), request), 404);',
    );
    // RS-9 — `type` is present and `about:blank`, written through setProperty
    // so Spring's NON_DEFAULT suppression cannot drop it.
    expect(advice).toContain('problem.setProperty("type", "about:blank");');
  });

  it("a LIST find is untouched — it has no absence to answer", async () => {
    // Scope guard: `Order[]` answers `[]`, never a 404 (RS-23), so the arm
    // must not have grown a throw.  Without this, a fix that threw on every
    // null-ish find would pass the two tests above.
    const files_ = await generateSystemFiles(ABSENCE_SRC);
    const ctrl = files_.get(
      "api/src/main/java/com/loom/api/features/orders/OrdersController.java",
    )!;
    const listArm = ctrl.slice(ctrl.indexOf('@GetMapping("/list_find")'));
    const nextRoute = listArm.indexOf("@GetMapping", 1);
    const body = nextRoute === -1 ? listArm : listArm.slice(0, nextRoute);
    expect(body).toContain("return service.listFind(code);");
    expect(body).not.toContain("AggregateNotFoundException");
  });
});
