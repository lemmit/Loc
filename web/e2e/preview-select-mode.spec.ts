// Preview element-select mode (M-T8.20 slice 4) — the HEAVY lane.
//
// This is the one leg of the mission that genuinely needs a running app: the
// click has to land on a real DOM element inside the preview iframe, which
// means Generate → Bundle → Boot, which means the npm registry and PGlite's
// WASM.  The spec self-skips when the browser cannot reach the registry (the
// same probe `runtime.spec.ts` uses), so it costs nothing in the no-network
// lane and is not a substitute for a gate there.
//
// The RESOLUTION half — `data-testid` → generated page → `.ddd` declaration —
// is proven headlessly and network-free in
// `test/playground/select-target.test.ts`; what only this spec can prove is
// the bridge: arming the mode from the parent, the in-frame controller
// swallowing the click, and the id coming back over the port.

import { expect, test } from "@playwright/test";
import {
  browserCanReachNetwork,
  selectExample,
  waitForBundle,
  waitForPlaygroundReady,
} from "./_helpers";

test("Select in the preview footer resolves a clicked element to its page", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  if (!(await browserCanReachNetwork(page))) {
    test.skip(true, "browser cannot reach the npm registry from this environment");
  }

  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("btn-bundle").click();
  await waitForBundle(page);
  await page.getByTestId("devtools-tab-backend").click();
  await page.getByTestId("btn-boot").click();
  await expect(page.getByTestId("backend-status")).toHaveText("booted", { timeout: 600_000 });

  // Arm select mode from the parent's footer toggle.
  const toggle = page.getByTestId("preview-select-toggle");
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-active", "true");

  // Click a primitive the generated Products list page renders.  In select
  // mode the click must be SWALLOWED (no navigation) and reported instead.
  const frame = page.frameLocator('[data-testid="preview-iframe"]');
  const nav = frame.getByRole("link", { name: /Products/i }).first();
  await nav.click();
  const list = frame.locator('[data-testid="products-list"]');
  await expect(list).toBeVisible({ timeout: 60_000 });

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-active", "true");
  await list.click();

  const result = page.getByTestId("select-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute("data-kind", "found");
  await expect(result).toContainText("WebApp.products.List");
  // The toggle disarms itself after one pick — the in-frame controller and
  // the parent state have to agree, or the button lies about being armed.
  await expect(toggle).not.toHaveAttribute("data-active", "true");
  // And the two follow-ups the mission names are offered.
  await expect(page.getByTestId("select-open-builder")).toBeVisible();
  await expect(page.getByTestId("select-ask-agent")).toBeVisible();
});
