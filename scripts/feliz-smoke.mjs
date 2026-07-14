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

  // 3b. Typed + validated form state — open the create form and prove the
  // validity guard runs: the "Create Product" submit is DISABLED while the
  // required text/number fields are empty, and ENABLES once they're filled.
  // (The bool `inStock` field is a checkbox, excluded from the guard.)
  await page.getByRole("button", { name: "Add a product" }).click();
  await page.getByText("New product").waitFor();
  const create = page.getByRole("button", { name: "Create Product" });
  if (!(await create.isDisabled())) {
    throw new Error("create submit should be DISABLED with empty required fields");
  }
  await page.getByPlaceholder("name").fill("Widget");
  await page.getByPlaceholder("price").fill("9.99");
  // Toggle the bool field's checkbox — proves the checkbox widget dispatches.
  await page.getByRole("checkbox").check();
  // Pick a non-default enum value — proves the <select> widget dispatches.
  // The first combobox is the `status` enum (the `category` FK select follows;
  // its options load from a backend, absent here, so it stays blank + optional).
  await page.getByRole("combobox").first().selectOption("inactive");
  // Fill a flattened value-object sub-field — proves the nested-VO input renders
  // + dispatches (the `contact: Contact` VO flattens to `contactEmail`/`Phone`).
  await page.getByPlaceholder("contactEmail").fill("a@b.com");
  // Fill a scalar-array field — proves the comma-separated array input dispatches
  // (`tags: string[]?` → a "tags (comma-separated)" input, encoded to a JSON array).
  await page.getByPlaceholder("tags (comma-separated)").fill("x, y, z");
  if (!(await create.isEnabled())) {
    throw new Error("create submit should be ENABLED once required fields are filled");
  }

  // 4. Back navigation works too (Cancel → Products → Back home).
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Back home" }).click();
  await page.getByText("Clicks:", { exact: false }).waitFor();

  if (errors.length > 0) {
    throw new Error(`page errors:\n${errors.join("\n")}`);
  }
  console.log(
    "SMOKE OK — mount + MVU counter + routing + wire layer + form validity guard all ran",
  );
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
