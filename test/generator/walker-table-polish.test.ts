// Table polish (`striped` / `highlight` / `sticky` /
//   `rowTestid:` props).
//
// Round out the `Table` primitive surface so the explicit DSL can
// reproduce the scaffold List page's table styling + per-row
// testid namespace.  Scaffold list tables emit
// `<Table striped highlightOnHover stickyHeader>` and
// `<Table.Tr data-testid={`<slug>-row-${row.id}`}>`; the walker
// supports both.
//
// What this test pins:
//   1. `striped: true` adds `striped` to the root `<Table>` opening tag.
//   2. `highlight: true` adds `highlightOnHover`.
//   3. `sticky: true` adds `stickyHeader`.
//   4. `rowTestid: r => <expr>` lifts `r → row` (the
//      lambdaParams scope) and emits `data-testid={<expr>}` on
//      each row.
//   5. Tables without these props emit identically to the baseline output.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

const ordersTableBody = (tableBody: string) => `
  system S {
    api SalesApi from Sales
    module Sales {
      context C {
        aggregate Order {
          customerId: string display
          status:     string
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrdersList { route: "/orders"  body: ${tableBody} }
    }
    deployable api { platform: hono, modules: Sales, serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
  }
`;

describe("Table polish props", () => {
  it("striped: true adds `striped` to the <Table> opening tag", async () => {
    const files = await buildAndGenerate(
      ordersTableBody(`Table(rows: Sales.Order.all, striped: true, Column("ID", o => o.id))`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toMatch(/<Table[^>]*\bstriped\b/);
    expect(tsx).not.toMatch(/<Table[^>]*\bhighlightOnHover\b/);
    expect(tsx).not.toMatch(/<Table[^>]*\bstickyHeader\b/);
  });

  it("highlight: true adds `highlightOnHover`", async () => {
    const files = await buildAndGenerate(
      ordersTableBody(`Table(rows: Sales.Order.all, highlight: true, Column("ID", o => o.id))`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toMatch(/<Table[^>]*\bhighlightOnHover\b/);
  });

  it("sticky: true adds `stickyHeader`", async () => {
    const files = await buildAndGenerate(
      ordersTableBody(`Table(rows: Sales.Order.all, sticky: true, Column("ID", o => o.id))`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toMatch(/<Table[^>]*\bstickyHeader\b/);
  });

  it("all three style toggles combine without losing ordering", async () => {
    const files = await buildAndGenerate(
      ordersTableBody(
        `Table(rows: Sales.Order.all, striped: true, highlight: true, sticky: true, Column("ID", o => o.id))`,
      ),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toMatch(/<Table striped highlightOnHover stickyHeader>/);
  });

  it('rowTestid: r => "prefix-" + r.id emits data-testid={…} on each <Table.Tr>', async () => {
    const files = await buildAndGenerate(
      ordersTableBody(
        `Table(
          rows: Sales.Order.all,
          rowTestid: r => "orders-row-" + r.id,
          Column("ID", o => o.id)
        )`,
      ),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    expect(tsx).toMatch(
      /<Table\.Tr key=\{ row\.id \} data-testid=\{ \("orders-row-" \+ row\.id\) \}>/,
    );
  });

  it("rowTestid + onRowClick compose on the same <Table.Tr>", async () => {
    const files = await buildAndGenerate(
      ordersTableBody(
        `Table(
          rows: Sales.Order.all,
          rowTestid: r => "orders-row-" + r.id,
          onRowClick: r => navigate("/orders"),
          Column("ID", o => o.id)
        )`,
      ),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // Both attrs land on the same opening tag.
    expect(tsx).toMatch(/<Table\.Tr[^>]*\bdata-testid=\{[^>]*\bonClick=\{/);
  });

  it("Table without style props still emits the baseline shape", async () => {
    const files = await buildAndGenerate(
      ordersTableBody(`Table(rows: Sales.Order.all, Column("ID", o => o.id))`),
    );
    const tsx = files.get("web/src/pages/orders_list.tsx")!;
    // No extra style props on <Table>; just the open tag.
    expect(tsx).toMatch(/<Table>\s/);
  });
});
