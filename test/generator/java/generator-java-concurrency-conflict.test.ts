// ---------------------------------------------------------------------------
// Java / Spring Boot + JPA backend — the `versioned` capability annotates the
// version field with JPA `@Version` (Hibernate write-time optimistic lock) and
// adds a think-time CAS: the controller reads the `If-Match` header, the service
// compares it against the loaded aggregate's version and throws
// `ObjectOptimisticLockingFailureException` on a mismatch; the RFC 7807 advice
// maps that to 409 Conflict with a distinct `conflict` catalog event.  A
// NON-versioned aggregate is byte-identical — gated on `aggregateIsVersioned`.
//
// Sibling of generator-java-unique-conflict.test.ts (the 23505 → 409 mapping).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const javaSystem = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
          operation update(newName: string) { name := newName }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: java
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 8081
    }
  }
`;

const ROOT = "api/src/main/java/com/loom/api";
const feature = `${ROOT}/features/customers`;

describe("java generator — versioned optimistic-concurrency", () => {
  it("entity annotates the version field with JPA @Version", async () => {
    const entity = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${feature}/Customer.java`,
    )!;
    expect(entity, "Customer.java missing").toBeTruthy();
    expect(entity).toContain("@Version");
    expect(entity).toContain('@Column(name = "version")');
    expect(entity).toContain("int version;");
  });

  it("service compares the If-Match version and throws OptimisticLockingFailure", async () => {
    const service = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${feature}/CustomerService.java`,
    )!;
    expect(service).toContain(
      "import org.springframework.orm.ObjectOptimisticLockingFailureException;",
    );
    expect(service).toContain(
      "public void update(CustomerId id, UpdateCustomerRequest request, Integer ifMatch) {",
    );
    expect(service).toContain(
      "if (ifMatch != null && aggregate.version() != ifMatch) throw new ObjectOptimisticLockingFailureException(Customer.class, id.value());",
    );
  });

  it("controller binds the If-Match header and passes it to the service", async () => {
    const controller = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${feature}/CustomersController.java`,
    )!;
    expect(controller).toContain(
      '@RequestHeader(value = "If-Match", required = false) Integer ifMatch',
    );
    expect(controller).toContain("service.update(new CustomerId(id), request, ifMatch);");
  });

  it("advice maps OptimisticLockingFailure to 409 with a distinct `conflict` event", async () => {
    const advice = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${ROOT}/api/ApiExceptionAdvice.java`,
    )!;
    expect(advice).toContain(
      "@ExceptionHandler(org.springframework.orm.ObjectOptimisticLockingFailureException.class)",
    );
    expect(advice).toContain(
      "public ResponseEntity<ProblemDetail> onConcurrencyConflict(ObjectOptimisticLockingFailureException e, WebRequest request) {",
    );
    expect(advice).toContain('CatalogLog.event("conflict", "warn",');
    expect(advice).toMatch(/return respond\(problem\(409, "Conflict",[\s\S]*?, 409\);/);
  });

  it("a NON-versioned aggregate emits byte-identical output (no @Version, no CAS)", async () => {
    const files = await generateSystemFiles(javaSystem(""));
    const entity = files.get(`${feature}/Customer.java`)!;
    const service = files.get(`${feature}/CustomerService.java`)!;
    const advice = files.get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(entity).not.toContain("@Version");
    expect(entity).not.toContain("version");
    expect(service).not.toContain("ObjectOptimisticLockingFailureException");
    expect(service).not.toContain("ifMatch");
    expect(advice).not.toContain("ObjectOptimisticLockingFailureException");
    expect(advice).not.toContain('"conflict"');
  });
});
