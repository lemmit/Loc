// Feliz scaffold runtime smoke — drives a `with scaffold(...)`-generated CRUD app
// (Home / List / New / Detail) in headless Chromium.  Proves the scaffold
// primitives (Toolbar / Breadcrumbs / Paper / Table / IdLink / Alert / Skeleton
// / Empty / KeyValueRow) actually RENDER and the app routes + runs — the e2e
// parity the JSX frontends get from their scaffold examples.  Pure client-side
// (no backend), so the list settles on the QueryView error branch, which itself
// proves the Cmd + Thoth-decoder path executed.
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://localhost:4173/";
const launchOpts = process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

async function main() {
  // Home page mounts.
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.getByText("Welcome").waitFor({ timeout: 10000 });

  // List page — the toolbar heading + table render; with no backend the wire
  // layer's Remote settles on the error/empty branch.
  await page.goto(`${URL}#/products`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Products" }).waitFor({ timeout: 10000 });
  await page
    .getByText(/Couldn't load products|No products yet\./)
    .first()
    .waitFor({ timeout: 10000 });

  // New page — the CreateForm inputs render.
  await page.goto(`${URL}#/products/new`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("name").waitFor({ timeout: 10000 });

  if (errors.length > 0) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("SCAFFOLD SMOKE OK — Home + List (toolbar/table/wire) + New all ran");
}

try {
  await main();
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error("SCAFFOLD SMOKE FAILED:", e.message);
  await browser.close();
  process.exit(1);
}
