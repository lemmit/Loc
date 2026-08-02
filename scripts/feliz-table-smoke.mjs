// Feliz `Table` control smoke (M-T1.1) — drives the previewed showcase bundle's
// ProductTable page in headless Chromium and proves the emitted F# sort / pager
// / filter actually BEHAVE, not just compile.
//
// The sibling `feliz-smoke.mjs` runs with no backend at all, which is enough to
// prove the wire layer executed but leaves a table with zero rows — nothing to
// sort or page.  So this one stubs the list response with `page.route`: still no
// server, but the controls get real rows to act on.  What that buys over a
// string-level generator test: the F# is Fable-compiled and the assertions are
// on RENDERED ROWS, so a wrong window (`List.skip` off by one), a lexicographic
// compare on a numeric column, or a pager counting the unfiltered set all fail
// here and cannot fail in a snapshot.
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://localhost:4173/";
const browser = await chromium.launch(
  process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {},
);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const rows = ["delta", "alpha", "echo", "bravo", "charlie", "foxtrot", "golf"].map((n, i) => ({
  id: `p${i}`,
  name: n,
  price: `${i + 1}.00`,
  inStock: true,
  note: null,
  status: "active",
  category: null,
  contact: { email: null, phone: null },
  tags: null,
  version: 1,
}));

async function names() {
  return await page
    .locator('[data-testid="product-table"] tbody tr td:first-child')
    .allTextContents();
}

try {
  await page.route("**/api/products*", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      // The FULL paged envelope, which is what `GET /api/products` actually
      // serves (`.all` is paged-by-default, M-T2.6) — this stub predated the
      // flip and sent `items` alone, which the wire decoder now rejects along
      // with the rest of the response.  The counts describe ONE server page
      // holding every row; the pager under test is the CLIENT one, which
      // computes its own window from `rows.length` and `pageSize: 3`.
      body: JSON.stringify({
        items: rows,
        page: 1,
        pageSize: rows.length,
        total: rows.length,
        totalPages: 1,
      }),
    }),
  );
  await page.goto(`${URL}products/table`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Product table" }).waitFor({ timeout: 10000 });

  // pageSize 3 over 7 rows → 3 pages, unsorted order preserved.
  await page.getByText("Page 1 of 3").waitFor({ timeout: 10000 });
  const eq = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  eq(await names(), ["delta", "alpha", "echo"], "page 1");

  // Pager walks the window and clamps at the end.
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Page 2 of 3").waitFor();
  eq(await names(), ["bravo", "charlie", "foxtrot"], "page 2");
  await page.getByRole("button", { name: "Next" }).click();
  eq(await names(), ["golf"], "page 3");
  if (!(await page.getByRole("button", { name: "Next" }).isDisabled()))
    throw new Error("Next should be disabled on the last page");
  await page.getByRole("button", { name: "Prev" }).click();
  await page.getByRole("button", { name: "Prev" }).click();
  if (!(await page.getByRole("button", { name: "Prev" }).isDisabled()))
    throw new Error("Prev should be disabled on page 1");

  // Sort ascending, then descending on re-click.
  await page.getByRole("button", { name: /^Name/ }).click();
  eq(await names(), ["alpha", "bravo", "charlie"], "sorted asc");
  await page.getByRole("button", { name: /^Name/ }).click();
  eq(await names(), ["golf", "foxtrot", "echo"], "sorted desc");

  // A second sortable column takes over the sort (and resets to ascending),
  // which only works if the emitted `match` carries an arm per column — a
  // single-arm or key-less sort would leave the previous descending order.
  await page.getByRole("button", { name: /^Price/ }).click();
  eq(await names(), ["delta", "alpha", "echo"], "price asc");

  // Filter narrows the set AND the page count.
  // "o" matches echo / bravo / foxtrot / golf — 4 of 7, so the page COUNT
  // drops from 3 to 2 too (the pager counts the filtered set, not the source).
  await page.getByTestId("table-filter").fill("o");
  await page.getByText("Page 1 of 2").waitFor();
  eq(await names(), ["echo", "bravo", "foxtrot"], "filtered");
  await page.getByTestId("table-filter").fill("");
  await page.getByText("Page 1 of 3").waitFor();

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("feliz table smoke OK");
} finally {
  await browser.close();
}
