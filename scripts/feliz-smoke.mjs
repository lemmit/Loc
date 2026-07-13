// Feliz runtime smoke — drives the previewed CRUD showcase bundle in headless
// Chromium.  Proves the emitted app actually RUNS (MVU loop + routing + the wire
// layer's Remote state), not just compiles.  Pure client-side (no backend), so
// the QueryView settles on its error/empty branch — that itself proves the
// Cmd/decoder path executed.
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://localhost:4173/";
// A pinned Playwright may not match the pre-installed browser build; allow an
// explicit executable (set in CI / the sandbox) and fall back to the bundled one.
const launchOpts = process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

async function main() {
  await page.goto(URL, { waitUntil: "networkidle" });

  // 1. The app mounts — the Home page heading renders.
  await page.getByText("Storefront").waitFor({ timeout: 10000 });

  // 2. MVU loop — the counter increments on dispatch.
  await page.getByText("Clicks: 0").waitFor();
  await page.getByRole("button", { name: "+" }).click();
  await page.getByText("Clicks: 1").waitFor();
  await page.getByRole("button", { name: "+" }).click();
  await page.getByText("Clicks: 2").waitFor();

  // 3. Routing — navigate to the Products page (Feliz.Router hash route).
  await page.getByRole("button", { name: "Browse products" }).click();
  await page.getByText("Products", { exact: false }).waitFor();
  // The wire layer ran: with no backend the QueryView settles on error/empty.
  await page
    .getByText(/Failed to load|No products yet\./)
    .first()
    .waitFor({ timeout: 10000 });

  // 4. Back navigation works too.
  await page.getByRole("button", { name: "Back home" }).click();
  await page.getByText("Clicks:", { exact: false }).waitFor();

  if (errors.length > 0) {
    throw new Error(`page errors:\n${errors.join("\n")}`);
  }
  console.log("SMOKE OK — mount + MVU counter + routing + wire layer all ran");
}

try {
  await main();
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error("SMOKE FAILED:", e.message);
  await browser.close();
  process.exit(1);
}
