// Runtime regression: when the user picks the pinned `mantine@v9`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  Earlier
// PRs in this thread chased symptoms via static analysis (Chakra
// icons, RDC shim, importmap URL form) and missed the duplicate-
// React class of bug because we had no automated runtime gate.
// This spec is that gate — the in-browser npm-install bundler needs the
// npm registry, so it self-skips when the browser sandbox can't reach it
// (same idiom as `runtime.spec.ts`).
//
// What it gates specifically:
// - `dispatcher.getOwner is not a function` (PR #151-#152 hunt)
// - `ReactDOM.createRoot is not a function` (PR #149 hunt)
// - any pageerror surfaced by React-19 rendering the storybook tree

import { expect, test } from "@playwright/test";
import { browserCanReachNetwork, waitForPlaygroundReady } from "./_helpers";

test("mantine@v9 preview boots without runtime errors", async ({ page }) => {
  // Capture *every* console error + pageerror surfaced both in the
  // playground host and inside the iframe sandbox.  The iframe shares
  // the page's console (it's same-origin) so a single listener catches
  // both ends.
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Pick the pinned mantine@v9 storybook.  This is the only example
  // that exercises stack v2; the bareword Mantine entry still maps
  // to stack v1 (mantine@v7) until `BUILTIN_PACK_LATEST.mantine`
  // flips in a follow-up PR.
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /Mantine 9 · pinned storybook/ }).click();

  // Wait for auto-Generate to populate the file tree.
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });

  if (!(await browserCanReachNetwork(page))) {
    test.skip(
      true,
      "Browser cannot reach the npm registry — Bundle + Preview need network access.  This spec is intended to run on the deployed playground CI step.",
    );
  }

  // Bundle the React frontend.  The in-browser npm install fetches the
  // React 19 runtime and Mantine 9 — ~140 modules; first cold run ~30 s.
  await page.getByTestId("btn-bundle").click();
  await expect(
    page.getByText(/bundled .*KB in \d+ ms \(\d+ deps fetched\)/),
  ).toBeVisible({ timeout: 300_000 });

  // Boot the Hono backend — PGlite WASM + .data come from jsdelivr.
  await page.getByTestId("btn-boot").click();
  await expect(page.getByTestId("backend-status")).toHaveText("booted", {
    timeout: 300_000,
  });

  // Switch to Preview.  This is where the iframe loads the bundle
  // and the runtime errors fire if React 19 isn't wired correctly.
  // Preview is always mounted in the four-region shell — no tab to click.
    await expect(page.getByTestId("preview-region")).toBeVisible();
  const iframe = page.frameLocator('[data-testid="preview-iframe"]');

  // First content render — wait for *any* aggregate label to appear.
  // The storybook example emits a Catalog / Sales / CustomerMgmt
  // module structure; "Home" is the shared landing page.
  await expect(iframe.getByText(/Home|Catalog|Sales|Customers/i).first()).toBeVisible({
    timeout: 60_000,
  });

  // Now the gate: no runtime errors during render.  The two
  // failure modes we explicitly watch for:
  //   - dispatcher.getOwner (two-Reacts duplication)
  //   - ReactDOM.createRoot (default-import vs namespace mismatch)
  // Pageerror-level surfaces both.  We also reject any unexpected
  // console.error — Mantine 9 + React 19 shouldn't emit any at
  // steady state on a happy-path mount.
  const fatal = errors.filter((m) => {
    // Suppress the well-known noise that's not related to our bundle:
    //   - 503/504 transients from the npm registry under load
    //   - "Using direct eval" warnings from esbuild-wasm
    //   - cross-origin postMessage chatter from the SW handshake
    return (
      !/Fetch failed \(50[34]\)/.test(m) &&
      !/Using direct eval/i.test(m) &&
      !/Cross-Origin-Resource-Policy/i.test(m)
    );
  });
  expect(fatal, "iframe runtime errors during mantine@v9 mount").toEqual([]);
});
