// M-T1.1 — client-side paginated Table on Vue.
//
// A `Table` carrying a `page:` int state ref + `pageSize:` slices its rows to
// the active window (`.slice(...)`) and appends a Prev / "Page N of M" / Next
// pager. `@click` writes the ref in place; `Math` is on Vue's template global
// allow-list. Verified end-to-end: `vue-tsc --noEmit` + `vite build` pass.
//
// The state field is `pageNum`, not `page` (a reserved grammar keyword — a
// `page` state field wouldn't parse; the scaffold names it `pageNum` too).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genPage(body: string, state = `state { pageNum: int = 1 }`) {
  const files = await generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: vue
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  return files.get("web/src/pages/x.vue")!;
}

describe("Table client-side pagination (Vue)", () => {
  it("a paged Table slices rows + emits a @click pager, ref init 1", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, page: pageNum, pageSize: 25) }`,
    );
    expect(content).toContain(".slice((pageNum - 1) * 25, pageNum * 25)");
    expect(content).toContain('data-testid="pager"');
    expect(content).toContain('@click="pageNum = pageNum - 1"');
    expect(content).toContain('@click="pageNum = pageNum + 1"');
    expect(content).toContain(':disabled="pageNum <= 1"');
    expect(content).toContain("Page {{ pageNum }} of {{ Math.max(1, Math.ceil(");
    // The int state ref initialises to 1 (honours the `= 1` initializer).
    expect(content).toContain("const pageNum = ref(1);");
  });

  it("a Table without page: is unaffected (no slice, no pager)", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    expect(content).not.toContain(".slice(");
    expect(content).not.toContain('data-testid="pager"');
  });
});
