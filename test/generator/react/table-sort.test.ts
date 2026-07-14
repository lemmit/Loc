// M-T1.1 — client-side sortable Table columns on React.
//
// A `Table` carrying `sortKey:`/`sortDir:` page-state refs plus one or more
// `Column(..., sortable: true)` renders clickable headers that drive a
// client-side sort over the bound rows.  A Table without the sort args is
// unaffected (the seam is opt-in and byte-identical when absent).

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

async function genPage(
  body: string,
  state = `state { sortKey: string = ""  sortDir: string = "asc" }`,
) {
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

describe("Table client-side sort (React)", () => {
  it("sortable columns emit clickable headers + a sorted rows chain", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, sortKey: sortKey, sortDir: sortDir) }`,
    );
    // Clickable header toggling sort state.
    expect(content).toMatch(/onClick=\{\(\) => \{ if \(sortKey === "name"\)/);
    expect(content).toContain('setSortKey("name")');
    expect(content).toContain('setSortDir("asc")');
    // Active-column indicator.
    expect(content).toContain('{sortKey === "name" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}');
    // The rows expression (QueryView binds `rows` to the hook's `.data`) is
    // wrapped in a client-side sort.
    expect(content).toMatch(/\[\.\.\.\(customerAll\.data\)\]\.sort\(\(a, b\) =>/);
    expect(content).toContain("(a as Record<string, unknown>)[sortKey]");
    // The sort state is declared via useState.
    expect(content).toMatch(/const \[sortKey, setSortKey\] = useState/);
    expect(content).toMatch(/const \[sortDir, setSortDir\] = useState/);
  });

  it("a non-sortable column keeps a plain header", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        Column("Tier", o => o.tier),
        rows: rows, sortKey: sortKey, sortDir: sortDir) }`,
    );
    // "Tier" header is plain text, not wrapped in a clickable span.
    expect(content).toMatch(/>Tier</);
    expect(content).not.toMatch(/onClick=\{[^}]*"tier"/);
  });

  it("an explicit field: overrides the accessor-derived sort key", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Customer", o => o.name, sortable: true, field: "name"),
        rows: rows, sortKey: sortKey, sortDir: sortDir) }`,
    );
    expect(content).toContain('setSortKey("name")');
  });

  it("a Table without sort args is unaffected (no sort chain, no clickable header)", async () => {
    const content = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    expect(content).not.toContain(".sort((a, b)");
    expect(content).not.toMatch(/onClick=\{\(\) => \{ if \(sortKey/);
    expect(content).toMatch(/>Name</);
  });
});
