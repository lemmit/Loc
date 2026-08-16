// ---------------------------------------------------------------------------
// Java / Spring Boot + JPA backend — the `versioned` capability.
//
// TWO halves, and the first one is a NEGATIVE:
//
//  1. `version` is mapped as a PLAIN column — deliberately NOT JPA `@Version`
//     (RS-20).  Hibernate's `@Version` counts ROW DIRTINESS: a command confined
//     to a `contains` child never bumped it, an idempotent re-assignment never
//     bumped it, and a create that also wrote a value-object collection bumped
//     it twice.  The capability declares a COMMAND counter (`version: int token
//     = 1`, +1 per persisted mutation — ir/util/versioned-capability.ts), which
//     is what node/dotnet/python/elixir emit, so java drives the counter itself
//     from the repository save: a guarded `update … set version = version + 1
//     where id = :id and version = :expected`, one row == bumped, zero rows on
//     an existing row == another writer won the race.
//  2. The think-time CAS is unchanged: the controller reads the `If-Match`
//     header, the service compares it against the loaded aggregate's version and
//     throws `ObjectOptimisticLockingFailureException`; the RFC 7807 advice maps
//     that (and the write-time zero-row case) to 409 Conflict with a distinct
//     `conflict` catalog event.
//
// As of default-on versioning (M-T3.4) every non-event-sourced aggregate is
// `versioned` even without a `with versioned` clause, so the counter, CAS and
// 409 arm all appear by default.
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
  it("entity maps version as a PLAIN column — never JPA @Version (RS-20)", async () => {
    const entity = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${feature}/Customer.java`,
    )!;
    expect(entity, "Customer.java missing").toBeTruthy();
    // The NEGATIVE is the whole point: `@Version` would hand the counter back to
    // Hibernate's dirty check and re-open RS-20's three divergences.
    expect(entity).not.toContain("@Version");
    expect(entity).toContain('@Column(name = "version")');
    expect(entity).toContain("int version;");
    // …and the persist site needs a way to write the counter back onto the live
    // instance (the response DTO is projected off it), across packages —
    // `directoryLayout` can split entity and repository impl.
    expect(entity).toContain("public void _applyVersion(int next) {");
    expect(entity).toContain("this.version = next;");
    // The create factory seeds the counter; a create matches no row, so this is
    // the value the insert carries.
    expect(entity).toContain("e.version = 1;");
  });

  it("Spring Data repository declares the GUARDED version bump", async () => {
    const jpa = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${feature}/CustomerJpaRepository.java`,
    )!;
    expect(jpa, "CustomerJpaRepository.java missing").toBeTruthy();
    expect(jpa).toContain("import org.springframework.data.jpa.repository.Modifying;");
    // flushAutomatically writes the command's pending changes BEFORE the bump;
    // clearAutomatically = false keeps the managed instance the impl mutates.
    expect(jpa).toContain("@Modifying(flushAutomatically = true, clearAutomatically = false)");
    expect(jpa).toContain(
      '@Query("update Customer e set e.version = e.version + 1 where e.id = :id and e.version = :expected")',
    );
    expect(jpa).toContain(
      'int bumpVersion(@Param("id") CustomerId id, @Param("expected") int expected);',
    );
  });

  it("repository save bumps once per persisted command and 409s on a lost race", async () => {
    const impl = (await generateSystemFiles(javaSystem("with versioned"))).get(
      `${feature}/CustomerRepositoryImpl.java`,
    )!;
    expect(impl, "CustomerRepositoryImpl.java missing").toBeTruthy();
    expect(impl).toContain(
      "import org.springframework.orm.ObjectOptimisticLockingFailureException;",
    );
    // A @Modifying query needs an active transaction of its own when the caller
    // (seed / bootstrap) has none.
    expect(impl).toContain("@Transactional");
    expect(impl).toContain("var __expectedVersion = aggregate.version();");
    expect(impl).toContain("if (jpa.bumpVersion(aggregate.id(), __expectedVersion) == 1) {");
    expect(impl).toContain("aggregate._applyVersion(__expectedVersion + 1);");
    // Zero rows + the row EXISTS = another writer moved it inside our load→save
    // window.  Zero rows + no row = a create (the factory already seeded 1).
    expect(impl).toContain("} else if (jpa.existsById(aggregate.id())) {");
    expect(impl).toContain(
      "throw new ObjectOptimisticLockingFailureException(Customer.class, aggregate.id().value());",
    );
    // …and the bump precedes the actual persist.
    expect(impl.indexOf("jpa.bumpVersion")).toBeLessThan(impl.indexOf("var saved = jpa.save("));
  });

  it("a NON-versioned aggregate keeps a bump-free save", async () => {
    // Event-sourced aggregates opt out of the `versioned` capability, so the
    // guarded bump must be gated, not unconditional — otherwise every aggregate
    // would reference a `bumpVersion` its repository never declares.
    const files = await generateSystemFiles(`
      system ES {
        subdomain D {
          context C {
            event Credited { account: Ledger id, amount: int }
            aggregate Ledger persistedAs: eventLog {
              balance: int
              create open() { emit Credited { account: id, amount: 0 } }
              operation credit(a: int) { emit Credited { account: id, amount: a } }
              apply(e: Credited) { balance := balance + e.amount }
            }
            repository Ledgers for Ledger { }
          }
        }
        api A from D
        storage primarySql { type: postgres }
        resource st { for: C, kind: state, use: primarySql }
        deployable api {
          platform: java
          contexts: [C]
          dataSources: [st]
          serves: A
          port: 8081
        }
      }
    `);
    const entity = files.get(`${ROOT}/features/ledgers/Ledger.java`)!;
    expect(entity, "Ledger.java missing").toBeTruthy();
    expect(entity).not.toContain("@Version");
    expect(entity).not.toContain("_applyVersion");
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
  // concrete subclass emitter skips inherited fields — so the counter's mutator
  // has to land on the BASE or it lands nowhere.  Historically this was where
  // `@Version` was forgotten entirely (`version` froze at the factory's 1 across
  // the whole hierarchy, found by the `payments`/`tph` update callers); the same
  // structural trap applies to `_applyVersion`, so both strategies are pinned.
  //
  // Both are asserted because they map differently — TPH's base is a real
  // `@Entity` (SINGLE_TABLE), TPC's is a `@MappedSuperclass` — and the negatives
  // pin that the mutator is on the base, not duplicated onto the concrete.
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

  for (const [label, using] of [
    ["TPH", "sharedTable"],
    ["TPC", "ownTable"],
  ] as const) {
    it(`a ${label} abstract base owns the counter mutator and carries no @Version`, async () => {
      const files = await generateSystemFiles(inheritedSystem(using));
      const base = files.get(`${ROOT}/features/vehicles/Vehicle.java`)!;
      expect(base, "Vehicle.java (abstract base) missing").toBeTruthy();
      expect(base).toContain(
        using === "sharedTable"
          ? "@Inheritance(strategy = InheritanceType.SINGLE_TABLE)"
          : "@MappedSuperclass",
      );
      expect(base).not.toContain("@Version");
      expect(base).toMatch(/@Column\(name = "version"\)\s*\n\s*protected int version;/);
      expect(base).toContain("public void _applyVersion(int next) {");
      expect(base).toContain("this.version = next;");
      // The concrete redeclares neither the field nor the mutator.
      const concrete = files.get(`${ROOT}/features/cars/Car.java`)!;
      expect(concrete, "Car.java missing").toBeTruthy();
      expect(concrete).not.toContain("int version;");
      expect(concrete).not.toContain("@Version");
      expect(concrete).not.toContain("_applyVersion");
      // …and the concrete's repository drives the bump through the shared id.
      const jpa = files.get(`${ROOT}/features/cars/CarJpaRepository.java`)!;
      expect(jpa).toContain(
        '@Query("update Car e set e.version = e.version + 1 where e.id = :id and e.version = :expected")',
      );
      // TPH shares the base's identity; a TPC concrete owns its own typed id.
      expect(jpa).toContain(
        `int bumpVersion(@Param("id") ${using === "sharedTable" ? "Vehicle" : "Car"}Id id, @Param("expected") int expected);`,
      );
    });
  }

  it("an aggregate without a `with versioned` clause still gets the counter + CAS — default-on (M-T3.4)", async () => {
    const files = await generateSystemFiles(javaSystem(""));
    const entity = files.get(`${feature}/Customer.java`)!;
    const jpa = files.get(`${feature}/CustomerJpaRepository.java`)!;
    const service = files.get(`${feature}/CustomerService.java`)!;
    const advice = files.get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(entity).not.toContain("@Version");
    expect(entity).toContain("int version;");
    expect(entity).toContain("_applyVersion");
    expect(jpa).toContain("bumpVersion");
    expect(service).toContain("ObjectOptimisticLockingFailureException");
    expect(service).toContain("ifMatch");
    expect(advice).toContain("ObjectOptimisticLockingFailureException");
    expect(advice).toContain('"conflict"');
  });
});
