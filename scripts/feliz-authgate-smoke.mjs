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
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

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
await page.route("**/api/products/smoke-id", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "smoke-id", name: "Widget", price: "0", active: false }),
  }),
);

// The one-click action's POST target — record that the write actually fired.
let activatePosted = false;
await page.route("**/api/products/smoke-id/activate", (route) => {
  if (route.request().method() === "POST") activatePosted = true;
  return route.fulfill({ status: 204, body: "" });
});

async function main() {
  // 1) Admin claims → the gated page renders its real body.
  role = "admin";
  await page.goto(`${URL}#/admin`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Admin Console" }).waitFor({ timeout: 10000 });

  // 2) Admin claims → the gated one-click Action button renders on the detail
  //    page; clicking it fires the real POST (the write path).
  await page.goto(`${URL}#/products/smoke-id`, { waitUntil: "networkidle" });
  const activate = page.getByRole("button", { name: "Activate" });
  await activate.waitFor({ timeout: 10000 });
  await activate.click();
  await page.waitForTimeout(500);
  if (!activatePosted) throw new Error("clicking Activate should POST /activate");

  // 3) Viewer claims → the SAME gated page renders the Forbidden fallback, and
  //    the gated Action button is hidden on the detail page.
  role = "viewer";
  await page.goto(`${URL}#/admin`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" }); // re-init → re-probe with the new role
  await page.getByRole("heading", { name: "Forbidden" }).waitFor({ timeout: 10000 });
  if (await page.getByRole("heading", { name: "Admin Console" }).isVisible()) {
    throw new Error("viewer role should NOT see the gated Admin Console body");
  }
  await page.goto(`${URL}#/products/smoke-id`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Widget" }).waitFor({ timeout: 10000 });
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
