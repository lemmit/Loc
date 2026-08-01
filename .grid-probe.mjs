// Ad-hoc runtime probe: does a generated grid page render its COMPUTED cells?
// Stubs the list read, then reports the first body row's cells.
import { chromium } from "playwright";

const port = process.env.PORT;
const path = process.env.PATHNAME ?? "/customers";
const rows = ["delta", "alpha", "echo"].map((n, i) => ({
  id: `c${i}`,
  name: n,
  sequence: i + 1,
  tier: ["Gold", "Silver", "Bronze"][i],
  signedUpAt: `2024-01-0${i + 1}T00:00:00Z`,
  version: 1,
}));

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", String(e).split("\n")[0]));
p.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE ERROR:", m.text().slice(0, 160));
});
await p.route(/\/api\/customers/, (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: rows, total: rows.length, page: 1, pageSize: 25, totalPages: 1 }),
  }),
);
await p.goto(`http://localhost:${port}${path}`, { waitUntil: "networkidle" });
const grid = p.locator('[data-testid="customer-data-grid"]');
try {
  await grid.waitFor({ timeout: 8000 });
} catch {
  console.log("GRID NEVER RENDERED");
  console.log("body:", (await p.locator("body").innerText()).slice(0, 200).replace(/\n+/g, " | "));
  await b.close();
  process.exit(1);
}
console.log("row 1 cells:", await grid.locator("tbody tr:first-child td").allTextContents());
console.log("selected label:", (await p.getByText(/^Selected: /).textContent())?.trim());
await b.close();
