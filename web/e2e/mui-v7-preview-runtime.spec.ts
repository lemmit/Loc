// Runtime regression: when the user picks the pinned `mui@v7`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  MUI v7
// runs on stack v2 (React 19) and swaps in the new Grid (formerly
// Grid2) — a static `tsc` pass can't prove the tree mounts, so
// this is the runtime gate.  The in-browser npm-install bundler needs the
// npm registry, so it self-skips when the browser sandbox can't reach it
// (same idiom as `runtime.spec.ts`).

import { expect, test } from "@playwright/test";
import { browserCanReachNetwork, waitForPlaygroundReady } from "./_helpers";

// #1242 (fixed): not a runtime stall — the bundle completes, prepare()
// resolves, and the footer toast renders.  The spec asserted "…KB…", but the
// Hono bundle is MB-scale, so `formatBytes` emits "MB" and the KB-only regex
// never matched — reading as a 600s "stall".  The toast matcher below is now
// unit-agnostic ([\d.]+ [KM]?B).
test("mui@v7 preview boots without runtime errors", async ({ page }) => {
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

  // Pick the pinned mui@v7 storybook.  The bareword MUI entry still
  // maps to mui@v5 until `BUILTIN_PACK_LATEST.mui` flips in a
  // follow-up promote PR.
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /MUI v7 · aggregate-CRUD storybook/ }).click();
  await page.getByTestId("workspace-create").click();

  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });

  if (!(await browserCanReachNetwork(page))) {
    test.skip(
      true,
      "Browser cannot reach the npm registry — Bundle + Preview need network access.  This spec is intended to run on the deployed playground CI step.",
    );
  }

  await page.getByTestId("btn-bundle").click();
  await expect(
    page.getByText(/bundled [\d.]+ [KM]?B in \d+ ms \(\d+ deps fetched\)/),
  ).toBeVisible({ timeout: 600_000 });

  await page.getByTestId("btn-boot").click();
  await expect(page.getByTestId("backend-status")).toHaveText("booted", {
    timeout: 600_000,
  });

  // Preview is always mounted in the four-region shell — no tab to click.
    await expect(page.getByTestId("preview-region")).toBeVisible();
  const iframe = page.frameLocator('[data-testid="preview-iframe"]');

  await expect(iframe.getByText(/Home|Catalog|Sales|Customers/i).first()).toBeVisible({
    timeout: 60_000,
  });

  const fatal = errors.filter((m) => {
    return (
      !/Fetch failed \(50[34]\)/.test(m) &&
      !/Using direct eval/i.test(m) &&
      !/Cross-Origin-Resource-Policy/i.test(m)
    );
  });
  expect(fatal, "iframe runtime errors during mui@v7 mount").toEqual([]);
});
