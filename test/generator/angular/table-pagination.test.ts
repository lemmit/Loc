// M-T1.1 — client-side paginated Table on Angular.
//
// A `Table` carrying a `page:` int signal + `pageSize:` slices its rows to the
// active window and appends a Prev / "Page N of M" / Next pager. Signals read
// as `pageNum()` and write as `pageNum.set(…)`; `Math` is re-exposed as a
// component member (templates can't reach the global). Verified end-to-end:
// `ng build` passes on the generated project.
//
// The state field is `pageNum`, not `page` (a reserved grammar keyword — a
// `page` state field wouldn't parse; the scaffold names it `pageNum` too).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genComponent(body: string, state = `state { pageNum: int = 1 }`) {
  const files = await generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: angular
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  for (const [k, v] of files) if (k.endsWith("x.component.ts")) return v;
  throw new Error("no x.component.ts emitted");
}

describe("Table client-side pagination (Angular)", () => {
  it("a paged Table slices rows via signal + emits a (click) pager, Math re-exposed", async () => {
    const content = await genComponent(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, page: pageNum, pageSize: 25) }`,
    );
    expect(content).toContain(".slice((pageNum() - 1) * 25, pageNum() * 25)");
    expect(content).toContain('data-testid="pager"');
    expect(content).toContain('(click)="pageNum.set(pageNum() - 1)"');
    expect(content).toContain('(click)="pageNum.set(pageNum() + 1)"');
    expect(content).toContain('[disabled]="pageNum() <= 1"');
    expect(content).toContain("Page {{ pageNum() }} of {{ Math.max(1, Math.ceil(");
    // The signal initialises to 1, and `Math` is re-exposed as a member.
    expect(content).toContain("readonly pageNum = signal(1);");
    expect(content).toContain("protected readonly Math = Math;");
  });

  it("a Table without page: is unaffected (no slice, no pager, no Math member)", async () => {
    const content = await genComponent(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    expect(content).not.toContain(".slice(");
    expect(content).not.toContain('data-testid="pager"');
    expect(content).not.toContain("protected readonly Math = Math;");
  });
});
