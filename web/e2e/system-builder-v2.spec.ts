// Model builder v2 — drill-down backbone (Phase 1).
//
// The canvas IS the navigator: clicking a drillable construct (a system /
// module / context / aggregate) pushes a breadcrumb step and the view swaps to
// the children of that node. The breadcrumb home (Model) pops back to root.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

test("Model v2 drills system → context → aggregate via clicks, and the breadcrumb pops back", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("c4system-v2-crumb-home")).toBeVisible();

  // Root → drill into the system.
  const systemNode = page.locator('.react-flow__node[data-id^="system:"]').first();
  await expect(systemNode).toBeVisible({ timeout: 10_000 });
  await systemNode.click();
  await expect(page.getByTestId("c4system-v2-crumb-0")).toBeVisible({ timeout: 5_000 });

  // System view → drill into the first module.
  const moduleNode = page.locator('.react-flow__node[data-id^="module:"]').first();
  await expect(moduleNode).toBeVisible({ timeout: 5_000 });
  await moduleNode.click();
  await expect(page.getByTestId("c4system-v2-crumb-1")).toBeVisible();

  // Module → context → aggregate.
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-2")).toBeVisible();
  await page.locator('.react-flow__node[data-id^="aggregate:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-3")).toBeVisible();

  // Aggregate view shows its members (at least one operation in the Sales
  // example).
  await expect(page.locator('.react-flow__node[data-id^="operation:"]').first()).toBeVisible();

  // Breadcrumb home pops all the way back; the system node is selectable again.
  await page.getByTestId("c4system-v2-crumb-home").click();
  await expect(page.getByTestId("c4system-v2-crumb-0")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id^="system:"]').first()).toBeVisible();
});
