// Full pipeline E2E: Bundle → Boot → dispatch HTTP requests against
// the in-browser Hono backend.  Requires real internet because the
// bundler fetches ~150 modules from esm.sh and the runtime worker
// fetches PGlite's WASM + .data from jsdelivr.
//
// The spec self-skips if the test browser can't reach esm.sh —
// some sandbox environments allow Node-side network but block
// browser-context cross-origin fetches.  GitHub Pages deploys and
// any normal dev box pass this probe trivially.

import { expect, test } from "@playwright/test";
import {
  browserCanReachEsmSh,
  selectExample,
  waitForPlaygroundReady,
} from "./_helpers";

test("editor → generate → bundle → boot → dispatch", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Pin sales-system explicitly — the default example moved when
  // the storybook entries were added at the top of the dropdown.
  await selectExample(page, /Sales System/);

  if (!(await browserCanReachEsmSh(page))) {
    test.skip(true, "browser cannot reach esm.sh from this environment");
  }

  await test.step("Generate", async () => {
    await page.getByTestId("btn-generate").click();
    await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  });

  await test.step("Bundle", async () => {
    await page.getByTestId("btn-bundle").click();
    await expect(page.getByText(/bundled .*KB in \d+ ms \(\d+ deps fetched\)/)).toBeVisible({
      timeout: 180_000,
    });
  });

  await test.step("Boot", async () => {
    await page.getByTestId("btn-boot").click();
    await expect(page.getByTestId("backend-status")).toHaveText("booted", {
      timeout: 180_000,
    });
  });

  await test.step("GET /products → 200 []", async () => {
    await page.getByTestId("btn-send").click();
    await expect(page.getByTestId("resp-status")).toContainText("200", { timeout: 30_000 });
    await expect(page.getByTestId("resp-body")).toHaveText(/^\[\]$/);
  });

  await test.step("POST /products → 201", async () => {
    await page.getByTestId("req-method").click();
    await page.getByRole("option", { name: "POST" }).click();
    const body = page.getByTestId("req-body");
    await expect(body).toBeVisible();
    await body.fill(
      JSON.stringify({ sku: "PW-1", price: { amount: 9.99, currency: "USD" } }),
    );
    await page.getByTestId("btn-send").click();
    await expect(page.getByTestId("resp-status")).toContainText("201", { timeout: 30_000 });
    await expect(page.getByTestId("resp-body")).toContainText(/"id":\s*".+"/);
  });

  await test.step("GET /products → returns the inserted product", async () => {
    await page.getByTestId("req-method").click();
    await page.getByRole("option", { name: "GET" }).click();
    await page.getByTestId("btn-send").click();
    await expect(page.getByTestId("resp-status")).toContainText("200", { timeout: 30_000 });
    const text = await page.getByTestId("resp-body").textContent();
    expect(text, "list response body").toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sku).toBe("PW-1");
    expect(parsed[0].price.amount).toBe(9.99);
    expect(parsed[0].price.currency).toBe("USD");
  });

  await test.step("Service Worker serves the latest bundle on sandbox URL", async () => {
    // Switching to the Preview tab triggers the bundle push
    // (Preview.tsx subscribes to navigator.serviceWorker.ready and
    // posts the synthesized HTML to the SW).  Then a direct fetch
    // to the sandbox URL — same-origin, in-scope — must return the
    // pushed HTML rather than the 503 "bundle first" placeholder.
    await page.getByTestId("right-pane-tabs").locator("text=Preview").click();
    const result = await page.evaluate(async () => {
      const url = new URL("__loom_sandbox__/", location.href).toString();
      // Up to 10 s for the bundle push round-trip.
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const res = await fetch(url, { cache: "no-store" });
        const body = await res.text();
        if (res.status === 200 && body.includes("<div id=\"root\">")) {
          return { status: res.status, hasRoot: true };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { status: -1, hasRoot: false };
    });
    expect(result.hasRoot, "sandbox URL serves bundled HTML").toBe(true);
    expect(result.status).toBe(200);
  });

  await test.step("Preview loads the React app and round-trips a fetch", async () => {
    // The Preview tab is only meaningful when the source has a
    // React deployable.  The default Sales System example does;
    // assertions guard against running on a single-context source.
    await page.getByTestId("right-pane-tabs").locator("text=Preview").click();
    const iframe = page.frameLocator('[data-testid="preview-iframe"]');
    // Mantine renders into the iframe — wait for any visible heading
    // or the home-page link list the React generator emits.
    await expect(iframe.getByText(/Products|Orders|Home/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  // Final guard: surface any uncaught console errors that escaped
  // (Monaco workers, PGlite WASM loader, etc.).  Allow esm.sh
  // transient 503s the bundler retries through, and PGlite's
  // direct-eval warnings that have no functional impact.
  const fatal = consoleErrors.filter(
    (m) =>
      !/Fetch failed \(503\)/.test(m) &&
      !/passive event listener/i.test(m) &&
      !/Using direct eval/i.test(m),
  );
  expect(fatal, "browser console errors during full run").toEqual([]);
});
