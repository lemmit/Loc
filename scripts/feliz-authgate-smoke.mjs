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
// body so the Thoth decoder resolves.  `role` is swapped between the two runs.
let role = "admin";
await page.route("**/api/auth/me", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "u1", role }),
  }),
);

async function main() {
  // 1) Admin claims → the gated page renders its real body.
  role = "admin";
  await page.goto(`${URL}#/admin`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Admin Console" }).waitFor({ timeout: 10000 });

  // 2) Viewer claims → the SAME gated page renders the Forbidden fallback.
  role = "viewer";
  await page.goto(`${URL}#/admin`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" }); // re-init → re-probe with the new role
  await page.getByRole("heading", { name: "Forbidden" }).waitFor({ timeout: 10000 });
  if (await page.getByRole("heading", { name: "Admin Console" }).isVisible()) {
    throw new Error("viewer role should NOT see the gated Admin Console body");
  }

  if (errors.length > 0) throw new Error(`page errors:\n${errors.join("\n")}`);
  console.log("AUTH-GATE SMOKE OK — admin sees the gated body; viewer gets forbiddenView");
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
