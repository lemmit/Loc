// DataGrid across the four React design packs.
//
// The walker owns the TanStack wiring (column defs, view state, useReactTable);
// the pack owns only the chrome.  This pins that split: every pack must render
// the grid with ITS OWN components while the hook wiring stays identical.
//
// A pack missing `primitive-data-grid` would otherwise surface as a
// missing-renderer sentinel comment in generated output rather than a failure.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const GRID = `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
  Column("Name", o => o.name, sortable: true, filterable: true),
  Column("Tier", o => o.tier, sortable: true),
  rows: rows, multiSort: true, columnVisibility: true, testid: "customers-grid") }`;

async function genPage(design: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string  tier: int }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        api Sales: SalesApi
        page X { route: "/x"  body: ${GRID} }
      }
      resource ordersState { for: Orders, kind: state, use: pg }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, port: 3001, ui: WebApp { Sales: api }, design: ${design} }
    }
  `);
  return files.get("web/src/pages/x.tsx")!;
}

/** Pack → a component only that pack's grid chrome would emit. */
const PACK_MARKERS: Record<string, string> = {
  mantine: "<Table.Thead>",
  shadcn: "<TableHeader>",
  mui: "<TableSortLabel",
  chakra: "<Table.ColumnHeader",
};

describe("DataGrid — every React pack renders it", () => {
  for (const [design, marker] of Object.entries(PACK_MARKERS)) {
    it(`${design} renders the grid with its own chrome`, async () => {
      const page = await genPage(design);
      // No missing-renderer sentinel.
      expect(page).not.toMatch(/no renderer for/i);
      expect(page).toContain(marker);
    });

    it(`${design} keeps the TanStack wiring identical`, async () => {
      const page = await genPage(design);
      // The row model is the walker's job, not the pack's — so it must not vary.
      expect(page).toContain("const table = useReactTable({");
      expect(page).toContain("data: (rows ?? []) as T[]");
      expect(page).toContain("enableMultiSort: true");
      expect(page).toContain("getSortedRowModel: getSortedRowModel(),");
      expect(page).toContain("getFilteredRowModel: getFilteredRowModel(),");
      expect(page).toContain('from "@tanstack/react-table"');
      // …and the grid is a hoisted child component, not inline markup.
      expect(page).toContain("function CustomersGrid<T extends object>");
    });
  }
});
