// Java/Spring Boot — a query-time projection AGGREGATION carries the source
// aggregate's capability filters (audit A1).
//
// Java splits the filter set in two on the row path, and the aggregation has to
// honour BOTH halves:
//
//   - NON-principal (`softDeletable`) rides the entity's `@SQLRestriction`, or —
//     when some read `ignoring`s it — a PROMOTED `@Filter(autoEnabled = true)`.
//     Hibernate applies both to a JPQL query, so the aggregation inherits them;
//     what it did NOT do was DISABLE a promoted filter its own `ignoring` names.
//   - PRINCIPAL (tenancy) has no static SQL form, so the repository AND-s it
//     into each `@Query`.  The aggregation builds JPQL through
//     `EntityManager.createQuery`, which has no Spring Data SpEL layer, so it
//     was emitting no tenant predicate at all — a cross-tenant COUNT/SUM.
//
// `gradle testClasses` proves the JPQL string compiles as a string.  What is
// pinned here is the predicate itself and its binding.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain D {
      context C {
        enum OrderStatus { Draft Confirmed }
        aggregate Order with tenantOwned, softDeletable, crudish {
          code: string
          total: money
          status: OrderStatus
          derived display: string = code
        }
        repository Orders for Order { }
        criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed

        projection SalesTotals {
          orders: int
          revenue: money
          from Order as o
          where Confirmed
          select orders = count(), revenue = sum(o.total)
        }
        projection OrderVolume {
          total: int
          from Order as o
          select total = count()
        }
        projection SalesByStatus {
          status: OrderStatus
          orders: int
          from Order as o
          group by o.status
          select status = o.status, orders = count()
        }
        projection AllTimeVolume {
          total: int
          from Order as o
          ignoring softDeletable
          select total = count()
        }
      }
      context A { aggregate Organization with crudish { name: string } }
    }
    api Api from D
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    resource aState { for: A, kind: state, use: primary }
    deployable d {
      platform: java
      contexts: [C, A]
      dataSources: [cState, aState]
      serves: Api
      port: 4000
      auth: required
    }
  }
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

async function service(): Promise<string> {
  const f = await files();
  const k = [...f.keys()].find((key) => key.endsWith("views/CQueryProjections.java"));
  expect(k, "CQueryProjections.java not emitted").toBeDefined();
  return f.get(k!)!;
}

describe("java query-projection aggregations apply the source capability filters", () => {
  it("the WHOLE-TABLE aggregation ANDs the tenant predicate into the same JPQL as its `where`", async () => {
    const src = await service();
    expect(src).toContain(
      '"select count(e), sum(e.total) from Order e where (e.status = ' +
        'com.loom.d.domain.enums.OrderStatus.Confirmed) and (e.tenantId = :__cuTenantId)"',
    );
  });

  it("an UNFILTERED aggregation gets the tenant predicate as its entire WHERE", async () => {
    const src = await service();
    expect(src).toContain('"select count(e) from Order e where (e.tenantId = :__cuTenantId)"');
  });

  it("the GROUPED aggregation carries it before GROUP BY", async () => {
    const src = await service();
    expect(src).toContain(
      '"select e.status, count(e) from Order e where (e.tenantId = :__cuTenantId) ' +
        'group by e.status order by e.status"',
    );
  });

  it("binds the claim off the ambient accessor — `createQuery` has no SpEL layer", async () => {
    const src = await service();
    expect(src).toContain("var __cu = com.loom.d.auth.CurrentUserAccessor.currentOrNull();");
    expect(src).toContain('.setParameter("__cuTenantId", __cu == null ? null : __cu.tenantId())');
    // The Spring Data SpEL form is a legal parameter name ONLY inside a @Query;
    // emitting it here would fail at query preparation.
    expect(src).not.toContain("#{@currentUserAccessor");
    // …while the repository @Query keeps it, unchanged.
    const f = await files();
    const jpa = [...f.keys()].find((k) => k.endsWith("OrderJpaRepository.java"));
    expect(f.get(jpa!)!).toContain("e.tenantId = :#{@currentUserAccessor.user()?.tenantId()}");
  });

  it("`ignoring softDeletable` disables the promoted named filter for that read only", async () => {
    const src = await service();
    expect(src).toContain("public AllTimeVolumeRow allTimeVolume() {");
    expect(src).toContain("var __session = entityManager.unwrap(org.hibernate.Session.class);");
    expect(src).toContain('__session.disableFilter("softDeletable");');
    expect(src).toContain('__session.enableFilter("softDeletable");');
    // The tenant predicate it did NOT name still applies.
    expect(src).toContain('"select count(e) from Order e where (e.tenantId = :__cuTenantId)"');
    // The non-bypassing reads must not disable anything.
    expect(src.match(/disableFilter/g)?.length).toBe(1);
    // …and the not-deleted half rides the entity, exactly as on the row path.
    const f = await files();
    const entity = [...f.keys()].find((k) => k.endsWith("orders/Order.java"));
    expect(f.get(entity!)!).toContain(
      '@Filter(name = "softDeletable", condition = "not (is_deleted)")',
    );
  });
});
