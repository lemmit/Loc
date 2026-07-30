// Model builder on a phone-sized viewport (compact layout): the ROOT-level
// Overview mode. This spec used to gate v1's bottom-drawer inspector + its
// canvas overlay toolbar; v1's pane was retired in M-T8.13, so what it gates
// now is that Overview's toolbar — the chrome that inherited those controls —
// stays usable and clear of the canvas on a 390px viewport.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("Overview's toolbar is reachable on a phone viewport and sits above the canvas", async ({
  page,
}) => {
  await page.goto("/");
  // Mobile shell: the Model view is a SegmentedControl segment, not a tab.
  await page.getByTestId("mobile-doc-tab-model").click({ timeout: 30_000 });
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("c4system-v2-overview-toggle").click();
  await expect(page.getByTestId("c4system-v2-overview-canvas")).toBeVisible({ timeout: 20_000 });

  // The toolbar wraps above the canvas rather than floating over it — search
  // and the toggles stay tappable at phone width.
  const search = page.getByTestId("c4system-v2-search");
  await expect(search).toBeVisible();
  const toolbarBox = (await page.getByTestId("c4system-v2-overview-toolbar").boundingBox())!;
  const canvasBox = (await page.getByTestId("c4system-v2-overview-canvas").boundingBox())!;
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(canvasBox.y + 1);

  // Search narrows the graph — the match count appears once a query is active.
  await search.fill("Order");
  await expect(page.getByTestId("c4system-v2-match-count")).toBeVisible();

  // …and `‹ Model` returns to the drill-down navigator.
  await page.getByTestId("c4system-v2-overview-close").click();
  await expect(page.getByTestId("c4system-v2-crumb-home")).toBeVisible();
});
