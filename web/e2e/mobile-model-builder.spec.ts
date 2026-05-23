// Model builder on a phone-sized viewport (compact layout): the inspector is a
// bottom drawer reached via a bottom-right "Inspect / +" FAB, which must sit
// clear of the canvas overlay toolbar (search / toggles) pinned top-left.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("Inspect FAB sits below the overlay and opens the inspector drawer", async ({ page }) => {
  await page.goto("/");
  // Mobile shell: the Model view is a SegmentedControl segment, not a tab.
  await page.getByTestId("mobile-doc-tab-model").click({ timeout: 30_000 });
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 20_000 });

  const inspect = page.getByTestId("c4system-open-inspector");
  const overlay = page.getByTestId("c4system-search");
  await expect(inspect).toBeVisible();
  const inspectBox = (await inspect.boundingBox())!;
  const overlayBox = (await overlay.boundingBox())!;
  // The FAB is well below the top overlay toolbar — no collision.
  expect(inspectBox.y).toBeGreaterThan(overlayBox.y + 100);

  await inspect.click();
  // The drawer opens with the inspector content (assert content, not the
  // Mantine drawer root, which is a hidden wrapper).
  await expect(page.getByTestId("c4system-add-module")).toBeVisible();
});
