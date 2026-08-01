// Feliz `DataGrid` runtime smoke (M-T1.1 slice 10e) — drives the previewed
// showcase bundle's ProductGrid page in headless Chromium and proves the
// emitted F# runs the REAL TanStack row model, not merely that it compiled.
//
// Why this exists rather than another generator snapshot: the Feliz grid binds
// `@tanstack/table-core` through Fable interop, and every way that binding can
// be wrong is invisible to both the F# compiler and a DOM-shape assertion.
// The sharpest example is the bug that motivated the script — `table-core`'s
// `getState()` returns the RAW `state` option without merging its defaults, so
// a partial state throws inside `getHeaderGroups()` and the grid renders
// NOTHING, with `dotnet fable` and `vite build` both green.  (The shipped
// Svelte grid had exactly that defect, found the same way.)  So every assertion
// below is on BEHAVIOUR: which rows are visible, in which order, under which
// columns.
//
// Stubs the list response with `page.route` — still no backend, but a grid with
// zero rows has nothing to sort, filter, hide or select.  Sibling of
// `feliz-table-smoke.mjs`, which does the same for the simpler `Table`.
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://localhost:4173/";
const browser = await chromium.launch(
  process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {},
);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));

// `status` repeats so the SECOND sort key has ties to break — that is what
// makes the multi-sort assertion distinguishable from a single-column sort.
const ROWS = [
  { name: "delta", status: "inactive" },
  { name: "alpha", status: "active" },
  { name: "echo", status: "inactive" },
  { name: "bravo", status: "active" },
  { name: "charlie", status: "archived" },
].map((r, i) => ({
  id: `p${i}`,
  name: r.name,
  price: `${i + 1}.00`,
  inStock: true,
  note: null,
  status: r.status,
  category: null,
  contact: { email: null, phone: null },
  tags: null,
  version: 1,
}));

const grid = () => page.locator('[data-testid="product-grid"]');
/** Visible values of the Name column — column 1 is the selection checkbox. */
const names = () => grid().locator("tbody tr td:nth-child(2)").allTextContents();
/** How many cells each body row renders — drops when a column is hidden. */
const cellsPerRow = () => grid().locator("tbody tr:first-child td").count();
const sortBy = (label) => page.getByRole("button", { name: `Sort by ${label}` });
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

try {
  await page.route("**/api/products*", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: ROWS }),
    }),
  );
  await page.goto(`${URL}products/grid`, { waitUntil: "networkidle" });

  // The grid RENDERED at all — which is exactly what the `initialState` merge
  // buys.  Without it `getHeaderGroups()` throws and this region is blank.
  await grid().waitFor({ timeout: 10000 });
  eq(await names(), ["delta", "alpha", "echo", "bravo", "charlie"], "initial order");

  // --- Sort: the row model reorders, and re-clicking reverses --------------
  await sortBy("Name").click();
  eq(await names(), ["alpha", "bravo", "charlie", "delta", "echo"], "name asc");
  await sortBy("Name").click();
  eq(await names(), ["echo", "delta", "charlie", "bravo", "alpha"], "name desc");

  // `aria-sort` tracks the direction — the a11y contract the JSX packs ship.
  const ariaSort = await grid().locator("thead th").nth(1).getAttribute("aria-sort");
  if (ariaSort !== "descending") throw new Error(`aria-sort: got ${ariaSort}, want descending`);

  // --- MULTI-column sort — the whole reason DataGrid exists over Table -----
  // Shift-click ADDS a sort key rather than replacing it, so `status` orders
  // the rows and `name` breaks its ties.  A single-sort grid cannot produce
  // this ordering, which is what makes the assertion meaningful.
  await sortBy("Status").click(); // status asc, replacing the name sort
  await sortBy("Name").click({ modifiers: ["Shift"] }); // + name asc
  eq(
    await names(),
    ["alpha", "bravo", "charlie", "delta", "echo"],
    "multi-sort: status asc, then name asc",
  );

  // --- Per-column filter narrows the set ----------------------------------
  const filter = page.getByRole("searchbox", { name: "Filter by Name" });
  await filter.fill("a");
  eq(await names(), ["alpha", "bravo", "charlie", "delta"], "filter 'a' (echo drops out)");
  await filter.fill("zzz");
  eq(await names(), [], "filter with no matches");
  await filter.fill("");
  eq(await names(), ["alpha", "bravo", "charlie", "delta", "echo"], "filter cleared");

  // --- Column visibility: a hidden column really disappears ---------------
  const before = await cellsPerRow();
  await page.getByRole("checkbox", { name: "Status", exact: true }).click();
  const after = await cellsPerRow();
  if (after !== before - 1)
    throw new Error(`hiding a column: ${before} cells → ${after}, want ${before - 1}`);
  await page.getByRole("checkbox", { name: "Status", exact: true }).click();
  eq(await cellsPerRow(), before, "column restored");

  // --- Selection round-trips into PAGE state ------------------------------
  // The sibling `Selected: {selectedIds.length}` reads the page's `string[]`
  // state field, so this proves the whole path: TanStack's selection map → the
  // child's effect → the `SetSelectedIds` Msg → the Elmish Model → the view.
  // On Feliz that path is entirely different from every JSX target's, and none
  // of it is observable in the emitted markup.
  await page.getByText("Selected: 0").waitFor({ timeout: 5000 });
  await grid().locator('tbody tr:first-child input[type="checkbox"]').click();
  await page.getByText("Selected: 1").waitFor({ timeout: 5000 });
  await grid().locator('tbody tr:nth-child(2) input[type="checkbox"]').click();
  await page.getByText("Selected: 2").waitFor({ timeout: 5000 });
  await grid().locator('tbody tr:first-child input[type="checkbox"]').click();
  await page.getByText("Selected: 1").waitFor({ timeout: 5000 });
  // Select-all covers the whole page of rows.
  await grid().locator('thead input[type="checkbox"]').click();
  await page.getByText(`Selected: ${ROWS.length}`).waitFor({ timeout: 5000 });

  // --- A computed cell rendered its MARKUP, not the raw value -------------
  // `Column("Price", p => Money { p.price })` has no accessorKey, so its content
  // comes from the projected row's lazy thunk.  A missing thunk shows as an
  // empty cell — no compiler catches that, and the DOM still has the <td>.
  const priceText = (await grid().locator("tbody tr:first-child td").nth(3).textContent())?.trim();
  if (!priceText) throw new Error("computed Price cell rendered empty");

  if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("feliz data-grid smoke: OK");
} finally {
  await browser.close();
}
