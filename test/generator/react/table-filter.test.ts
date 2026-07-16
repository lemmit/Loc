// M-T1.1 — client-side filterable Table on React (slice 7).
//
// A `Table` carrying a `filter:` page-state ref renders a search box above the
// table and narrows the bound rows by a case-insensitive substring match over
// every row value.  A Table without the `filter:` arg is unaffected (the seam
// is opt-in and byte-identical when absent).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SCAFFOLD = `
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
`;

async function genPage(body: string, state = `state { q: string = "" }`) {
  const files = await generateSystemFiles(`
    system S {
      ${SCAFFOLD}
      ui WebApp {
        framework: react
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  return files;
}

describe("Table client-side filter (React)", () => {
  it("a `filter:` ref emits a controlled search box + an inline .filter()", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, filter: q) }`,
    );
    const content = files.get("web/src/pages/x.tsx")!;
    // Controlled search input bound to the `q` state field.
    expect(content).toContain(
      `<input type="search" placeholder="Filter…" aria-label="Filter table" value={q} onChange={(e) => setQ(e.target.value)}`,
    );
    expect(content).toContain('data-testid="table-filter"');
    // Rows wrapped in an inline case-insensitive substring filter.
    expect(content).toContain("((customerAll.data.items) ?? []).filter((r) =>");
    expect(content).toContain("Object.values(r as Record<string, unknown>)");
    expect(content).toContain("String(v).toLowerCase().includes(__q)");
    // React inlines the filter — no shared helper file is emitted.
    expect(files.has("web/src/lib/table-sort.ts")).toBe(false);
  });

  it("filter, sort and pagination compose: filter → sort → slice, pager counts the filtered set", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        rows: rows, filter: q, sortKey: sortKey, sortDir: sortDir, page: pageNum, pageSize: 10) }`,
      `state { q: string = ""  sortKey: string = ""  sortDir: string = "asc"  pageNum: int = 1 }`,
    );
    const content = files.get("web/src/pages/x.tsx")!;
    // The rows chain nests filter INSIDE sort INSIDE slice.
    expect(content).toMatch(
      /\[\.\.\.\(\(\(customerAll\.data\.items\) \?\? \[\]\)\.filter\(\(r\) =>/,
    );
    expect(content).toContain(".sort((a, b) =>");
    expect(content).toContain(".slice((pageNum - 1) * 10, pageNum * 10)");
    // The pager total derives from the post-filter (pre-slice) length — no
    // redundant `?? []` guard on the already-non-null filtered array.
    expect(content).toContain("Math.ceil((");
    expect(content).not.toMatch(/\)\.filter\([^)]*\}\)\) \?\? \[\]\)\.length/);
  });

  it("a Table without `filter:` is unaffected (no search box, no .filter chain)", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    const content = files.get("web/src/pages/x.tsx")!;
    expect(content).not.toContain('data-testid="table-filter"');
    expect(content).not.toContain(".filter((r) =>");
  });
});
