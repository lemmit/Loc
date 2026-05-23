// Model builder v2 on a phone-width viewport (compact layout). v2's tab is a
// segment of the mobile shell's SegmentedControl; the canvas takes the full
// width (no side inspector), with the same drill + breadcrumb model as
// desktop. Compact node widths keep StmtNode + the deployable multi-select
// panel from overflowing the small canvas.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("Model v2 on mobile: drill into Sales System → context → aggregate", async ({ page }) => {
  await page.goto("/");
  // The desktop `waitForPlaygroundReady` helper looks for a heading hidden on
  // mobile; instead wait for the mobile model-v2 segment to be clickable.
  await page.getByTestId("mobile-doc-tab-model-v2").click({ timeout: 30_000 });
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("c4system-v2-crumb-home")).toBeVisible();

  // Drill all the way to Order: each tap drops one breadcrumb step deeper.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-0")).toBeVisible({ timeout: 5_000 });
  await page.locator('.react-flow__node[data-id^="module:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-1")).toBeVisible();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-2")).toBeVisible();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-v2-crumb-3")).toBeVisible();

  // The aggregate view shows Order's members; at least one operation appears.
  await expect(page.locator('.react-flow__node[data-id^="operation:"]').first()).toBeVisible();
});

test("Model v2 on mobile: operation body renders as a statement flow", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mobile-doc-tab-model-v2").click({ timeout: 30_000 });
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 20_000 });
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="module:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await page.locator('.react-flow__node[data-id="operation:confirm"]').click();

  // Stmt nodes render; the assign + emit rows are still recognisable inside
  // their compact-width StmtNode.
  await expect.poll(async () => page.getByTestId("c4system-v2-stmt").count(), { timeout: 5_000 }).toBeGreaterThan(0);
  await expect(page.locator('[data-testid="c4system-v2-stmt"][data-stmt-kind="emit"]')).toBeVisible();
});
