// M-T4.2 — the GROUPED read model on the Java/Spring backend: `group by`
// mixes per-row key selects with aggregate selects, one row per distinct
// group, computed IN SQL.  What this pins, each silently wrong when missed:
//
//  1. ONE JPQL query with `group by` AND `order by` over exactly the grouping
//     columns — the ORDER BY is what makes the list read deterministic across
//     backends, and a missing GROUP BY would be a query error only at runtime.
//  2. The `where` folds into the same query (filter BEFORE grouping).
//  3. The response is the LIST shape (`List<<P>Row>`) end to end — service and
//     controller — not the singleton object.
//  4. Result reads go through `Number`/`toString`, never a provider-specific
//     cast (JPQL aggregate result types are provider-chosen); the enum KEY
//     column comes back as the entity's own `@Enumerated` instance and casts
//     to the enum the row record declares.
//  5. A `requires` gate 403s in the controller BEFORE the query — exactly like
//     the per-row list routes (the singleton arm's missing gate is a known
//     pre-existing bug, deliberately NOT inherited here).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = `system Shop {
  user { id: string role: string }
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        lineCount: int
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order { }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesByStatus {
        status: OrderStatus
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        group by o.status
        select status = o.status, orders = count(), revenue = sum(o.total)
      }
      projection GatedByStatus {
        status: OrderStatus
        orders: int
        from Order as o
        requires currentUser.role == "admin"
        group by o.status
        select status = o.status, orders = count()
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: java contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 auth: required }
}`;

let cache: Map<string, string> | undefined;
async function fileEndingWith(suffix: string): Promise<string> {
  cache ??= await generateSystemFiles(SRC);
  for (const [path, content] of cache) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix}`);
}

describe("java grouped projection (group by)", () => {
  it("groups in ONE JPQL query with group by AND order by over the key", async () => {
    const svc = await fileEndingWith("OrdersQueryProjections.java");
    expect(svc).toContain(
      '"select e.status, count(e), sum(e.total) from Order e where ' +
        "e.status = com.loom.api.domain.enums.OrderStatus.Confirmed " +
        'group by e.status order by e.status"',
    );
    // Through the EntityManager, never a repository findAll materialising rows.
    expect(svc).toContain("@PersistenceContext");
    expect(svc).not.toContain(".findAll()");
  });

  it("returns the LIST shape from the service and the controller", async () => {
    const svc = await fileEndingWith("OrdersQueryProjections.java");
    expect(svc).toContain("public List<SalesByStatusRow> salesByStatus() {");
    // One row per Object[] result row — never getSingleResult.
    expect(svc).toContain("List<Object[]> rows = entityManager.createQuery(");
    expect(svc).toContain('@SuppressWarnings("unchecked")');
    const ctrl = await fileEndingWith("OrdersQueryProjectionsController.java");
    expect(ctrl).toContain("public List<SalesByStatusRow> salesByStatus() {");
    expect(ctrl).toContain('@GetMapping("/sales_by_status")');
  });

  it("casts the enum key to the declared row enum; aggregates read via Number/toString", async () => {
    const svc = await fileEndingWith("OrdersQueryProjections.java");
    // Key: the entity's @Enumerated(STRING) mapping hands back the enum
    // instance — cast to the declared record component type.
    // Aggregates: provider-chosen result types, so Number/toString discipline
    // exactly like the singleton arm (count → int, money sum → wire string).
    expect(svc).toContain(
      "new SalesByStatusRow((OrderStatus) r[0], ((Number) r[1]).intValue(), " +
        'r[2] == null ? "0" : r[2].toString())',
    );
    // No provider-specific casts on aggregate results.
    expect(svc).not.toContain("(Long) r[");
    expect(svc).not.toContain("(BigDecimal) r[");
  });

  it("the Row record declares the grouped wire shape", async () => {
    const row = await fileEndingWith("SalesByStatusRow.java");
    expect(row).toContain(
      "public record SalesByStatusRow(OrderStatus status, int orders, String revenue)",
    );
  });

  it("emits the requires gate in the controller, BEFORE the query — like the per-row routes", async () => {
    const ctrl = await fileEndingWith("OrdersQueryProjectionsController.java");
    const route = ctrl.slice(ctrl.indexOf('@GetMapping("/gated_by_status")'));
    expect(route).toContain("var currentUser = currentUserAccessor.user();");
    expect(route).toContain(
      'if (!(Objects.equals(currentUser.role(), "admin"))) throw new ForbiddenException("Forbidden: projection GatedByStatus");',
    );
    // Gate precedes the delegating read.
    expect(route.indexOf("ForbiddenException")).toBeLessThan(
      route.indexOf("queryProjections.gatedByStatus()"),
    );
    // The ungated grouped route carries no gate.
    const ungated = ctrl.slice(
      ctrl.indexOf('@GetMapping("/sales_by_status")'),
      ctrl.indexOf('@GetMapping("/gated_by_status")'),
    );
    expect(ungated).not.toContain("ForbiddenException");
  });
});
