// Feliz UI auth-gate runtime smoke — drives a gated app (a page carrying
// `requires currentUser.role == "admin"`) in headless Chromium, stubbing the
// backend `/api/auth/me` session probe so BOTH gate branches run for real:
//   • admin claims  → the gated page renders its body (the `Some currentUser
//                      when <gate>` arm + the Thoth claims decode both executed)
//   • viewer claims → the gated page renders `forbiddenView` (the `| _ ->` arm)
// This is the client mirror of the backend 403, proven end-to-end (not just at
// compile time).  Pure client-side: the stub is Playwright request interception,
// no backend.
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://localhost:4176/";
const launchOpts = process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {};
// The gated button appears only after two async Elmish Cmds resolve (the byId
// load + the claims probe) AND Fable re-renders.  Every `waitFor` below is
// gated on the concrete stubbed RESPONSE first (see `navAndAwait`), so the
// element wait is only ever the render tick — the generous ceiling is just a
// backstop against a genuinely slow CI runner, not the load-bearing wait.
const WAIT = { timeout: 30000 };
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Navigate, then block until the stubbed API responses that GATE the assertion
// have actually come back — the `waitForResponse` promise is armed BEFORE the
// goto that triggers it, so there is no race window.  This turns the smoke from
// "poll for the button and hope it shows up in 10s" into "wait for the exact
// network round-trips the gated UI depends on, then assert".
async function navAndAwait(hash, ...responseGlobs) {
  const pending = responseGlobs.map((glob) => page.waitForResponse(glob, WAIT));
  await page.goto(`${URL}#${hash}`, { waitUntil: "networkidle" });
  await Promise.all(pending);
}

// The session probe (`Http.get "/api/auth/me"`) — answer it with a JSON claims
// body so the Thoth decoder resolves.  `role` is swapped between the runs.
let role = "admin";
await page.route("**/api/auth/me", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "u1", role }),
  }),
);

// The byId detail read — return a product so the QueryView's `data:` branch
// (which hosts the gated `Action { p.activate }` button) actually renders.
// The body MUST carry every field the emitted Thoth decoder marks Required —
// notably the optimistic-concurrency `version` on every aggregate's wire shape;
// omit one and the decode fails, the Remote goes `LoadError`, and the QueryView
// renders its error branch (no button) — a silent, deterministic gate miss.
await page.route("**/api/products/smoke-id", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "smoke-id", name: "Widget", price: "0", active: false, version: 1 }),
  }),
);

// The one-click action's POST target — record that the write actually fired.
let activatePosted = false;
await page.route("**/api/products/smoke-id/activate", (route) => {
  if (route.request().method() === "POST") activatePosted = true;
  return route.fulfill({ status: 204, body: "" });
});

async function main() {
  // 1) Admin claims → the gated page renders its real body.  The initial load
  //    fires the `/api/auth/me` claims probe; wait for it before asserting.
  role = "admin";
  await navAndAwait("/admin", "**/api/auth/me");
  await page.getByRole("heading", { name: "Admin Console" }).waitFor(WAIT);

  // 2) Admin claims → the gated one-click Action button renders on the detail
  //    page; clicking it fires the real POST (the write path).  Hash-nav reuses
  //    the already-probed claims, so only the byId load gates the button.
  await navAndAwait("/products/smoke-id", "**/api/products/smoke-id");
  const activate = page.getByRole("button", { name: "Activate" });
  await activate.waitFor(WAIT);
  await activate.click();
  await page.waitForTimeout(500);
  if (!activatePosted) throw new Error("clicking Activate should POST /activate");

  // 3) Viewer claims → the SAME gated page renders the Forbidden fallback, and
  //    the gated Action button is hidden on the detail page.  A full reload
  //    re-inits the app so the claims probe re-fires with the new role — wait
  //    for THAT response (not the hash-nav, which reuses the cached claims).
  role = "viewer";
  await page.goto(`${URL}#/admin`, { waitUntil: "networkidle" });
  const reprobe = page.waitForResponse("**/api/auth/me", WAIT);
  await page.reload({ waitUntil: "networkidle" });
  await reprobe;
  await page.getByRole("heading", { name: "Forbidden" }).waitFor(WAIT);
  if (await page.getByRole("heading", { name: "Admin Console" }).isVisible()) {
    throw new Error("viewer role should NOT see the gated Admin Console body");
  }
  await navAndAwait("/products/smoke-id", "**/api/products/smoke-id");
  await page.getByRole("heading", { name: "Widget" }).waitFor(WAIT);
  if (await page.getByRole("button", { name: "Activate" }).isVisible()) {
    throw new Error("viewer role should NOT see the gated Activate action");
  }

  if (errors.length > 0) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log(
    "AUTH-GATE SMOKE OK — admin sees the gated page + fires the gated Action POST; viewer gets forbiddenView + no Action",
  );
}

try {
  await main();
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error("AUTH-GATE SMOKE FAILED:", e.message);
  await browser.close();
  process.exit(1);
}
