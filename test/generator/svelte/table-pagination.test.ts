// M-T1.1 — client-side paginated Table on Svelte.
//
// A `Table` carrying a `page:` int `$state` ref + `pageSize:` slices its rows
// to the active window and appends a Prev / "Page N of M" / Next pager.
// `onclick` reassigns the rune in place. Verified end-to-end: `svelte-check`
// (0 errors/warnings) + `vite build` pass.
//
// The state field is `pageNum`, not `page` (a reserved grammar keyword — a
// `page` state field wouldn't parse; the scaffold names it `pageNum` too).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genFiles(body: string, state = `state { pageNum: int = 1 }`) {
  return generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: svelte
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
}

function pageOf(files: Map<string, string>): string {
  for (const [k, v] of files) if (k.endsWith("+page.svelte") && k.includes("/x")) return v;
  for (const [k, v] of files) if (k.endsWith("+page.svelte")) return v;
  throw new Error("no +page.svelte emitted");
}

describe("Table client-side pagination (Svelte)", () => {
  it("a paged Table slices rows + emits an onclick pager, $state init 1", async () => {
    const content = pageOf(
      await genFiles(
        `QueryView { of: Sales.Customer.all, data: rows => Table(
          Column("Name", o => o.name),
          rows: rows, page: pageNum, pageSize: 25) }`,
      ),
    );
    expect(content).toContain(".slice((pageNum - 1) * 25, pageNum * 25)");
    expect(content).toContain('data-testid="pager"');
    expect(content).toContain("onclick={() => { pageNum = pageNum - 1; }}");
    expect(content).toContain("onclick={() => { pageNum = pageNum + 1; }}");
    expect(content).toContain("disabled={pageNum <= 1}");
    expect(content).toContain("Page {pageNum} of {Math.max(1, Math.ceil(");
    // The int rune initialises to 1 (honours the `= 1` initializer).
    expect(content).toContain("let pageNum = $state<number>(1);");
  });

  it("a Table without page: is unaffected (no slice, no pager)", async () => {
    const content = pageOf(
      await genFiles(
        `QueryView { of: Sales.Customer.all, data: rows => Table(
          Column("Name", o => o.name),
          rows: rows) }`,
        `state { }`,
      ),
    );
    expect(content).not.toContain(".slice(");
    expect(content).not.toContain('data-testid="pager"');
  });
});
