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

  // 2b. Page-level `derived` (M-T1.20) — a pure function of `state`, hoisted as
  // an F# `let` above the body and RECOMPUTED on every render.  Neither `dotnet
  // fable` nor `vite build` can see this: before the fix the body read lowered
  // to a `(* ref: doubled *)` comment, which compiles green and renders NOTHING.
  await page.getByText("Doubled: 4").waitFor();

  // 2c. Store persistence (M-T1.20) — the `persist:` tiers hydrate at `init` and
  // mirror back through the `update` wrapper.  First load: the declared defaults
  // (nothing stored yet), and the localStorage blob written on the first message
  // is keyed `loom.store.Draft` with the SAME JSON shape the JS frontends write.
  await page.getByText("Mode: dark").waitFor();
  const draftBlob = await page.evaluate(() => localStorage.getItem("loom.store.Draft"));
  const parsedDraft = JSON.parse(draftBlob ?? "null");
  if (
    parsedDraft === null ||
    parsedDraft.note !== "" ||
    parsedDraft.seen !== 0 ||
    parsedDraft.ok !== false ||
    !Array.isArray(parsedDraft.tags)
  ) {
    throw new Error(`store write-back missing/misshaped: ${draftBlob}`);
  }
  if ((await page.evaluate(() => sessionStorage.getItem("loom.store.Prefs"))) === null) {
    throw new Error("session-tier store never wrote its blob");
  }
  // Hydration: seed the blob, reload, and the Model must come back from storage
  // rather than from the declared default.
  await page.evaluate(() =>
    localStorage.setItem(
      "loom.store.Draft",
      JSON.stringify({ note: "hydrated", seen: 7, ok: true, price: "1.50", tags: ["a"] }),
    ),
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.getByText("Draft: hydrated").waitFor({ timeout: 10000 });
  // The `url` tier reads the query string as untrusted input.
  await page.goto(`${URL}?term=shoes`, { waitUntil: "networkidle" });
  await page.getByText("Term: shoes").waitFor({ timeout: 10000 });

  // 3. Routing — navigate to the Products page (Feliz.Router path route).
  // Target the page HEADING specifically: the app-shell navbar also carries a
  // "Products" link, so a bare getByText would match two elements.
  await page.getByRole("button", { name: "Browse products" }).click();
  await page.getByRole("heading", { name: "Products" }).waitFor();
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
  // M-T1.22 — the plain-`decimal` and `long` cells.  Both are REQUIRED and
  // both are numeric, so the submit stays disabled until they hold text that
  // parses: `weight` through `Decimal.TryParse`, `sold` through
  // `Int64.TryParse` (a value past int32, the range `long` exists to carry).
  await page.getByPlaceholder("weight").fill("1.2345");
  await page.getByPlaceholder("sold").fill("4294967296");
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
  // M-T1.22 — the pre-encode numeric guard.  A `type=number` input still holds
  // text, and the encoder converts with F#'s `int64`/`decimal`, which PARSE and
  // THROW.  A fractional value in the `long` cell must therefore DISABLE the
  // submit (an inline form error) rather than blow up in the Elmish loop.
  await page.getByPlaceholder("sold").fill("2.5");
  if (!(await create.isDisabled())) {
    throw new Error("create submit should be DISABLED with a non-integral `long` value");
  }
  await page.getByPlaceholder("sold").fill("4294967296");
  if (!(await create.isEnabled())) {
    throw new Error("create submit should re-ENABLE once the `long` value parses again");
  }

  // 4. Back navigation works too (Cancel → Products → Back home).
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Back home" }).click();
  await page.getByText("Clicks:", { exact: false }).waitFor();

  // 5. `match await` async effect (M-T6.15) — navigate to a detail page (the
  // route `:id` binds the trigger's id) and click Reserve.  The trigger fires
  // `Cmd.OfAsync.perform`; with no backend the POST throws → the `Error` arm
  // runs the `else` body → the page state flips to "unavailable".  Proves the
  // trigger→Cmd→result MVU projection executes end-to-end at runtime.
  await page.goto(`${URL}products/smoke-id`, { waitUntil: "networkidle" });
  await page.getByText("Reserve: idle").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Reserve", exact: true }).click();
  await page.getByText("Reserve: unavailable").waitFor({ timeout: 10000 });

  if (errors.length > 0) {
    throw new Error(`page errors:\n${errors.join("\n")}`);
  }
  console.log(
    "SMOKE OK — mount + MVU counter + routing + wire layer + form validity guard + async effect all ran",
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
