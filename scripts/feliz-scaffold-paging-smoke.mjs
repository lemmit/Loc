// Feliz SERVER-paged scaffold smoke (M-T2.6 Feliz leg) — drives the scaffolded
// list page and asserts the REQUESTS it makes, not just what it renders.
//
// That is the whole point of this script.  A pager that renders and a pager that
// pages look identical in the DOM when the backend is stubbed: both show "Page 2
// of 3" after a click.  The bug this guards against is the one the M-T1.1 slice
// had to gate off — a control that writes state nothing refetches on — and it is
// invisible to a render assertion.  So every assertion here is on the query
// string the app actually sent.
//
// No backend: `page.route` answers `/api/products` with a synthetic envelope
// whose `totalPages` the pager reads, and records each request.
import { chromium } from "playwright";

// NB: not named `URL` — this script parses request urls with the global
// `URL` class, which a same-named const would shadow.
const BASE = process.env.SMOKE_URL ?? "http://localhost:4175/";
const browser = await chromium.launch(
  process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {},
);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

/** Every `/api/products` query string the app has issued, in order. */
const queries = [];

function rowsFor(pageNum) {
  return [
    { id: `p${pageNum}a`, name: `Item ${pageNum}A`, price: "1.00", tags: [], version: 1 },
    { id: `p${pageNum}b`, name: `Item ${pageNum}B`, price: "2.00", tags: [], version: 1 },
  ];
}

const eq = (got, want, what) => {
  if (got !== want)
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

/** Wait until the app has issued `n` list requests (the refetch is a Cmd, so it
 *  lands a tick after the click). */
async function untilRequests(n) {
  for (let i = 0; i < 100; i++) {
    if (queries.length >= n) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`expected ${n} list requests, saw ${queries.length}: ${queries.join(" | ")}`);
}

try {
  // The auth gate probes the session; the preview server's SPA fallback would
  // answer with HTML, so answer it explicitly.
  await page.route("**/api/auth/me", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "u1", role: "admin" }),
    }),
  );
  await page.route("**/api/products?*", (r) => {
    const url = new URL(r.request().url());
    queries.push(url.search);
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: rowsFor(url.searchParams.get("page") ?? "1"),
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: 10,
        total: 6,
        totalPages: 3,
      }),
    });
  });

  await page.goto(`${BASE}products`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Products" }).waitFor({ timeout: 10000 });

  // 1. The FIRST request already carries the page/sort state, so what the pager
  //    renders and what the server was asked for cannot disagree.  `sort` is
  //    absent because no column is selected yet — `?sort=` would ask the backend
  //    to order by a column that does not exist.
  await untilRequests(1);
  eq(queries[0], "?page=1&pageSize=10", "initial query");

  // 2. The page count comes off the ENVELOPE, not off the row count.
  await page.getByText("Page 1 of 3").waitFor({ timeout: 10000 });

  // 3. Next REFETCHES with the new page — the assertion that separates a wired
  //    pager from a decorative one.
  await page.getByRole("button", { name: "Next" }).click();
  await untilRequests(2);
  eq(queries[1], "?page=2&pageSize=10", "after Next");
  await page.getByText("Page 2 of 3").waitFor();

  // 4. A sortable header refetches with the sort — and does so EXACTLY ONCE.
  //    Selecting a new column dispatches two Msgs (key, then direction); if both
  //    refetched, two requests would be in flight carrying different sorts and
  //    the later ARRIVAL would win, not the later request.  The refetch rides
  //    the direction arm alone, which every header branch dispatches last.
  await page.getByRole("button", { name: /^Name/ }).click();
  await untilRequests(3);
  await page.waitForTimeout(300);
  eq(queries.length, 3, "requests after selecting a sort column");
  eq(queries[2], "?page=2&pageSize=10&sort=name&dir=asc", "after header click");

  // 5. Re-clicking the active column flips the direction on the WIRE.
  await page.getByRole("button", { name: /^Name/ }).click();
  await untilRequests(4);
  await page.waitForTimeout(300);
  eq(queries.length, 4, "requests after flipping the sort");
  eq(queries[3], "?page=2&pageSize=10&sort=name&dir=desc", "after re-click");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(`feliz scaffold paging smoke OK (${queries.length} list requests)`);
} finally {
  await browser.close();
}
