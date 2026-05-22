// Runtime regression: when the user picks the pinned `chakra@v3`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  Chakra v3
// is the largest pack migration (createSystem theme, compound
// components everywhere, createToaster) and resolves the original
// `@chakra-ui/icons` forwardRef pain point — a static `tsc` pass
// can't prove the v3 component tree actually mounts, so this is the
// runtime gate.  The in-browser npm-install bundler needs the npm
// registry, so it self-skips when the browser sandbox can't reach it
// (same idiom as `runtime.spec.ts`).

import { expect, test } from "@playwright/test";
import { browserCanReachNetwork, waitForPlaygroundReady } from "./_helpers";

test("chakra@v3 preview boots without runtime errors", async ({ page }) => {
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

  // Pick the pinned chakra@v3 storybook.  The bareword Chakra entry
  // still maps to chakra@v2 until `BUILTIN_PACK_LATEST.chakra` flips
  // in a follow-up promote PR.
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /Chakra v3 · aggregate-CRUD storybook/ }).click();

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
  expect(fatal, "iframe runtime errors during chakra@v3 mount").toEqual([]);
});
