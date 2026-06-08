// Regression: creating a new workspace from the Acme ERP example and
// generating must succeed on the first attempt.
//
// Acme is the flagship multi-file example — `main.ddd` imports twelve
// companion `.ddd` files (subdomains, shared kernels, `ui/components.ddd`
// and `governance/requirements.ddd`).  The seed writes each file to the
// workspace store sequentially; the build worker's generate then reads
// the file set to push into its VFS.  Reading the React-state mirror of
// that set (rather than the controller's own synchronous snapshot) could
// lag the seed, so the first generate ran against a PARTIAL VFS and the
// project loader threw:
//
//   .ddd import not found in VFS: "./governance/requirements.ddd"
//
// (and, on a retry against the inconsistent state, unresolved cross-file
// `Targetable` references from requirements.ddd).  This drives the exact
// path — `selectExample` creates a fresh workspace from Acme — and asserts
// generation produces files with no "Generation failed".

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

test("new workspace from Acme ERP generates on the first attempt", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Create a fresh workspace seeded from the full Acme ERP example
  // (workspace-new → choose example → create).
  await selectExample(page, /Acme/);

  // Generate.  The whole import graph must resolve from the worker VFS —
  // every companion `.ddd`, including the last-seeded
  // governance/requirements.ddd and its cross-file targetable references.
  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });

  // The failure modes this guards against never reach the success state.
  await expect(page.getByText(/Generation failed/)).toHaveCount(0);
  await expect(page.getByText(/import not found in VFS/)).toHaveCount(0);
  await expect(page.getByText(/Could not resolve reference to Targetable/)).toHaveCount(0);
});
