// Runtime acceptance for the auto-paged hand-written table.
//
// Copied into the GENERATED frontend's `e2e/` dir by `paged-ui.mjs` (as
// `paged-ui.spec.ts`) and run by the emitted Playwright config against the
// live one-origin stack — built React bundle + generated Hono backend on
// PGlite — after 1000 widgets have been seeded over the real HTTP surface.
//
// It is hand-authored rather than emitted because the property under test
// needs a thousand rows and a click: the DSL's `test e2e` has no loop, so it
// can only ever seed a handful of rows — never enough for a real second page.
//
// What it proves, on data rather than on emitted text:
//   - the first window is one PAGE, not the whole table;
//   - `Next` fetches rows the first window never contained (the actual
//     defect: rows 21+ were unreachable);
//   - the pager's page count comes from the server's `totalPages`;
//   - the sort a column header writes reaches the server as a FIELD and a
//     DIRECTION, not as a client-side reshuffle of the rows in hand.
//
// The seed runs `name` opposite to `rank` (name asc == rank desc), so a sort
// that arrived on the wrong column is caught rather than masked.

import { expect, test } from "./fixtures";

const PAGE_SIZE = 20;
const TOTAL = 1000;
const PAGES = TOTAL / PAGE_SIZE;

const rows = (page: import("@playwright/test").Page) => page.locator("table tbody tr");
const pager = (page: import("@playwright/test").Page) => page.getByTestId("pager");
/** Nth row's Rank cell (column 1 — Name is column 0). */
const rankAt = (page: import("@playwright/test").Page, i: number) =>
  rows(page).nth(i).locator("td").nth(1);
const nameAt = (page: import("@playwright/test").Page, i: number) =>
  rows(page).nth(i).locator("td").nth(0);

/** Sort by a column, waiting for the re-fetch to land on `expectedFirstRank`. */
async function sortBy(
  page: import("@playwright/test").Page,
  header: string,
  expectedFirstRank: number,
) {
  await page.getByRole("button", { name: new RegExp(`^${header}`) }).click();
  await expect(rankAt(page, 0)).toHaveText(String(expectedFirstRank));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/widgets");
  // The rows arrive from the network; everything below is meaningless until
  // the first window has rendered.
  await expect(rows(page)).toHaveCount(PAGE_SIZE);
});

test("the first window is one page of the seeded 1000, with a pager that says so", async ({
  page,
}) => {
  // Not 1000 rows, and not a silent 20 either — a page, labelled as one.
  await expect(rows(page)).toHaveCount(PAGE_SIZE);
  // The count is the SERVER's totalPages.  A client that divided the rows it
  // holds by the page size would say "Page 1 of 1".
  await expect(pager(page)).toContainText(`Page 1 of ${PAGES}`);
  await expect(page.getByRole("button", { name: "Prev" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("Next reaches rows the first window never contained", async ({ page }) => {
  await sortBy(page, "Rank", 0);
  await expect(rankAt(page, PAGE_SIZE - 1)).toHaveText(String(PAGE_SIZE - 1));

  await page.getByRole("button", { name: "Next" }).click();

  await expect(pager(page)).toContainText(`Page 2 of ${PAGES}`);
  await expect(rows(page)).toHaveCount(PAGE_SIZE);
  // ranks 20..39 — the window that was unreachable before this shipped.
  await expect(rankAt(page, 0)).toHaveText(String(PAGE_SIZE));
  await expect(rankAt(page, PAGE_SIZE - 1)).toHaveText(String(2 * PAGE_SIZE - 1));

  // …and back, so the pager is navigation rather than a one-way ratchet.
  await page.getByRole("button", { name: "Prev" }).click();
  await expect(pager(page)).toContainText(`Page 1 of ${PAGES}`);
  await expect(rankAt(page, 0)).toHaveText("0");
});

test("the last page is reachable and the pager stops there", async ({ page }) => {
  await sortBy(page, "Rank", 0);
  // Page state lives in React, not in the URL, so the tail is reached the way
  // a user reaches it — one hop at a time.  Each hop asserts the new page
  // number BEFORE the next click: the click handler closes over `pageNum`, so
  // two clicks landing inside one render would both write the same value and
  // the walk would silently come up short.
  const next = page.getByRole("button", { name: "Next" });
  for (let i = 1; i < PAGES; i++) {
    await next.click();
    await expect(pager(page)).toContainText(`Page ${i + 1} of ${PAGES}`);
  }
  await expect(next).toBeDisabled();
  // rank 999 is the highest seeded value — the true tail, not a repeat of a
  // window the server clamped.
  await expect(rankAt(page, PAGE_SIZE - 1)).toHaveText(String(TOTAL - 1));
});

test("a column header sorts on the SERVER, by field and by direction", async ({ page }) => {
  // asc on rank → 0 first.
  await sortBy(page, "Rank", 0);
  // Clicking the same header again flips direction: 999 is on the far side of
  // the table from the rows in hand, so a client-side reversal of one window
  // could not produce it.
  await page.getByRole("button", { name: /^Rank/ }).click();
  await expect(rankAt(page, 0)).toHaveText(String(TOTAL - 1));

  // A DIFFERENT field.  `name` was seeded opposite to `rank`, so name-asc
  // must put the highest rank first — a server still ordering by `rank`
  // (or ignoring `sort` entirely) cannot produce this pair.
  await page.getByRole("button", { name: /^Name/ }).click();
  await expect(nameAt(page, 0)).toHaveText("w0000");
  await expect(rankAt(page, 0)).toHaveText(String(TOTAL - 1));
});
