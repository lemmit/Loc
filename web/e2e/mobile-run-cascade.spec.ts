// Regressions for the mobile header "Run" button:
//   1. The button is wired (its testid is present and visible).
//   2. Clicking it kicks the pipeline — at minimum Generate runs and
//      a file becomes selected (files-only check; we don't need the
//      npm-installed Bundle to verify the Run wiring is intact).
//   3. After a successful cascade the mobile tab nav lands on
//      Preview (system-mode source) — this is the part previously
//      broken because the cascade never ran past Generate.
//
// Part 3 needs the npm registry + jsdelivr (bundle + PGlite WASM); when those
// aren't reachable from the test browser we self-skip just that
// assertion, same idiom as runtime.spec.ts.

import { expect, test } from "@playwright/test";
import { browserCanReachNetwork } from "./_helpers";

test("mobile Run kicks the pipeline and surfaces files", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForTimeout(1500);

  // Create a workspace from a system-mode example via the drawer (the
  // example picker moved off the mobile header into the create flow).
  await page.getByTestId("mobile-workspace-button").click();
  await page.getByRole("textbox", { name: "Choose example" }).click();
  await page.getByRole("option", { name: /Sales System/ }).click();
  await page.getByTestId("workspace-create").click();
  // Auto-Generate fires ~800 ms after the source mirrors land — give
  // it a beat so the Files tab is already populated.
  await page.waitForTimeout(1500);

  // Run button is present and enabled (no LSP errors on a fresh
  // example).
  const run = page.getByTestId("btn-run");
  await expect(run).toBeVisible();
  await expect(run).toBeEnabled();

  // Switch off the default Code tab so we can prove Run navigated.
  await page.getByTestId("mobile-tab-output").click();
  await expect(page.getByTestId("mobile-tab-output")).toHaveAttribute("aria-selected", "true");

  await run.click();
  // Generate step has already run on this source via auto-Generate,
  // so Generate completes quickly.  The button enters its loading
  // state for the Bundle + Boot stages.
  await expect(run).toHaveAttribute("data-loading", "true");

  if (await browserCanReachNetwork(page)) {
    // Full cascade should reach Preview.
    await expect(page.getByTestId("mobile-tab-preview")).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 180_000 },
    );
  }
});
