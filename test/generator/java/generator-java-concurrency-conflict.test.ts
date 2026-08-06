// ---------------------------------------------------------------------------
// Java / Spring Boot + JPA backend — the `versioned` capability annotates the
// version field with JPA `@Version` (Hibernate write-time optimistic lock) and
// adds a think-time CAS: the controller reads the `If-Match` header, the service
// compares it against the loaded aggregate's version and throws
// `ObjectOptimisticLockingFailureException` on a mismatch; the RFC 7807 advice
// maps that to 409 Conflict with a distinct `conflict` catalog event.  As of
// default-on versioning (M-T3.4) every non-event-sourced aggregate is
// `versioned` even without a `with versioned` clause, so the annotation, CAS,
// and 409 arm all appear by default.
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

  // ── INHERITED aggregates ────────────────────────────────────────────────
  //
  // The `version` token field is declared ONCE, on the abstract base — the
  // concrete subclass emitter skips inherited fields — so `@Version` has to
  // land on the BASE or it lands nowhere.  It landed nowhere: `renderEntity`'s
  // token arm carried the comment "a TPH/TPC base carries it once" while
  // `renderAbstractBase` had no matching arm, so every subtype of an abstract
  // aggregate mapped `version` as a plain `@Column`.  Hibernate then never
  // incremented it and never emitted the `WHERE version = ?` CAS: `version`
  // froze at the create factory's `1` and the whole hierarchy's 409 guard was
  // inert.  Invisible to every test here because they all used a FLAT
  // aggregate; found at runtime by the caller census's `update` drain
  // (`payments`: golden `2` ≠ java `1` on the by-id read after
  // `POST /credit_cards/{id}/update`, and the same on `tph`).
  //
  // Both strategies are asserted because they map differently — TPH's base is a
  // real `@Entity` (SINGLE_TABLE), TPC's is a `@MappedSuperclass` — and the
  // negatives pin that the annotation is on the base, not duplicated onto the
  // concrete (a second `@Version` in one hierarchy is a Hibernate mapping
  // error, so "emit it on both" is not a safe over-approximation).
  const inheritedSystem = (using: string) => `
  system Fleet {
    subdomain D {
      context Yard {
        abstract aggregate Vehicle inheritanceUsing: ${using} {
          name: string
        }
        aggregate Car extends Vehicle {
          doors: int
          operation refit(d: int) { doors := d }
        }
        repository Cars for Car { }
      }
    }
    api A from D
    storage primarySql { type: postgres }
    resource st { for: Yard, kind: state, use: primarySql }
    deployable api {
      platform: java
      contexts: [Yard]
      dataSources: [st]
      serves: A
      port: 8081
    }
  }
`;

  it("a TPH abstract base annotates the inherited version field with @Version", async () => {
    const files = await generateSystemFiles(inheritedSystem("sharedTable"));
    const base = files.get(`${ROOT}/features/vehicles/Vehicle.java`)!;
    expect(base, "Vehicle.java (abstract TPH base) missing").toBeTruthy();
    // The base is the SINGLE_TABLE root, and it owns the version column.
    expect(base).toContain("@Inheritance(strategy = InheritanceType.SINGLE_TABLE)");
    expect(base).toMatch(
      /@Version\s*\n\s*@Column\(name = "version"\)\s*\n\s*protected int version;/,
    );
    // …and the concrete must NOT redeclare it (one @Version per hierarchy).
    const concrete = files.get(`${ROOT}/features/cars/Car.java`)!;
    expect(concrete, "Car.java missing").toBeTruthy();
    expect(concrete).not.toContain("int version;");
    expect(concrete).not.toContain("@Version");
  });

  it("a TPC abstract base annotates the inherited version field with @Version", async () => {
    const files = await generateSystemFiles(inheritedSystem("ownTable"));
    const base = files.get(`${ROOT}/features/vehicles/Vehicle.java`)!;
    expect(base, "Vehicle.java (abstract TPC base) missing").toBeTruthy();
    // A @MappedSuperclass's @Version is inherited by each concrete @Entity.
    expect(base).toContain("@MappedSuperclass");
    expect(base).toMatch(
      /@Version\s*\n\s*@Column\(name = "version"\)\s*\n\s*protected int version;/,
    );
    const concrete = files.get(`${ROOT}/features/cars/Car.java`)!;
    expect(concrete).not.toContain("@Version");
  });

  it("an aggregate without a `with versioned` clause still gets @Version + CAS — default-on (M-T3.4)", async () => {
    const files = await generateSystemFiles(javaSystem(""));
    const entity = files.get(`${feature}/Customer.java`)!;
    const service = files.get(`${feature}/CustomerService.java`)!;
    const advice = files.get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(entity).toContain("@Version");
    expect(entity).toContain("int version;");
    expect(service).toContain("ObjectOptimisticLockingFailureException");
    expect(service).toContain("ifMatch");
    expect(advice).toContain("ObjectOptimisticLockingFailureException");
    expect(advice).toContain('"conflict"');
  });
});
