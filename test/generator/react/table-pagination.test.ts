// M-T1.1 — client-side paginated Table on React.
//
// A `Table` carrying a `page:` page-state ref (a 1-based int) plus a
// `pageSize:` int literal slices its rows to the active window and appends a
// Prev / "Page N of M" / Next pager below itself.  A Table without `page:` is
// unaffected (the seam is opt-in and byte-identical when absent).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SCAFFOLD = `
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { find recent(): Customer }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
`;

async function genPage(body: string, state = `state { pageNum: int = 1 }`) {
  const files = await generateSystemFiles(`
    system S {
      ${SCAFFOLD}
      ui WebApp {
        api Sales: SalesApi
        page X {
          route: "/x"
          ${state}
          body: ${body}
        }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  return files.get("web/src/pages/x.tsx")!;
}

describe("Table client-side pagination (React)", () => {
  it("a paged Table slices rows to the page window + emits a pager", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.recent, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, page: pageNum, pageSize: 25) }`,
    );
    // The rows are sliced to the active page's window.
    expect(content).toContain(".slice((pageNum - 1) * 25, pageNum * 25)");
    // A pager control below the table, wired to the page state.
    expect(content).toContain('data-testid="pager"');
    expect(content).toContain("disabled={pageNum <= 1}");
    expect(content).toContain("onClick={() => setPageNum(pageNum - 1)}");
    expect(content).toContain("onClick={() => setPageNum(pageNum + 1)}");
    // "Page N of M" label + last-page disable off the total row count.
    expect(content).toContain("Page {pageNum} of {Math.max(1, Math.ceil(");
    expect(content).toContain(
      "disabled={pageNum >= Math.max(1, Math.ceil(((customerRecent.data) ?? []).length / 25))}",
    );
    // The page state is declared via useState<number>.
    expect(content).toMatch(/const \[pageNum, setPageNum\] = useState<number>\(1\)/);
    // Table + pager are two roots in the QueryView's `{cond && (…)}` slot, so
    // the multi-root output is wrapped in a JSX fragment (adjacent `<Table/>`
    // and `<div pager/>` are illegal JSX otherwise — TS2657).
    expect(content).toMatch(/<\/div>\s*<\/>/);
  });

  it("pageSize defaults to 10 when omitted", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.recent, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, page: pageNum) }`,
    );
    expect(content).toContain(".slice((pageNum - 1) * 10, pageNum * 10)");
  });

  it("sort + pagination compose — the window slices the sorted rows", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.recent, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        rows: rows, sortKey: sortKey, sortDir: sortDir, page: pageNum, pageSize: 10) }`,
      `state { sortKey: string = ""  sortDir: string = "asc"  pageNum: int = 1 }`,
    );
    // The slice wraps the sort chain (sort first, then window).
    expect(content).toMatch(/\.sort\(\(a, b\) =>.*\}\)\)\.slice\(\(pageNum - 1\) \* 10/s);
  });

  it("a Table without page: is unaffected (no slice, no pager)", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.recent, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    expect(content).not.toContain(".slice(");
    expect(content).not.toContain('data-testid="pager"');
  });
});
