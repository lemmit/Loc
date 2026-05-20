// Runtime regression: when the user picks the pinned `mui@v7`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  MUI v7
// runs on stack v2 (React 19) and swaps in the new Grid (formerly
// Grid2) — a static `tsc` pass can't prove the tree mounts, so
// this is the runtime gate.  esm.sh-dependent; self-skips when the
// browser sandbox can't reach the CDN (same idiom as
// `runtime.spec.ts`).

import { expect, test } from "@playwright/test";
import { browserCanReachEsmSh, waitForPlaygroundReady } from "./_helpers";

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
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /MUI v7 · aggregate-CRUD storybook/ }).click();

  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });

  if (!(await browserCanReachEsmSh(page))) {
    test.skip(
      true,
      "Browser cannot reach esm.sh — Bundle + Preview need network access.  This spec is intended to run on the deployed playground CI step.",
    );
  }

  await page.getByTestId("btn-bundle").click();
  await expect(
    page.getByText(/bundled .*KB in \d+ ms \(\d+ deps fetched\)/),
  ).toBeVisible({ timeout: 180_000 });

  await page.getByTestId("btn-boot").click();
  await expect(page.getByTestId("backend-status")).toHaveText("booted", {
    timeout: 180_000,
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
