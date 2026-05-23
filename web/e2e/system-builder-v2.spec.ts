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

  // Module → context → Order (the aggregate with operations).
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await expect(page.getByTestId("c4system-v2-crumb-2")).toBeVisible();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-v2-crumb-3")).toBeVisible();

  // Order's aggregate view shows its operations.
  await expect(page.locator('.react-flow__node[data-id^="operation:"]').first()).toBeVisible();

  // Breadcrumb home pops all the way back; the system node is selectable again.
  await page.getByTestId("c4system-v2-crumb-home").click();
  await expect(page.getByTestId("c4system-v2-crumb-0")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id^="system:"]').first()).toBeVisible();
});

test("Model v2 renders an operation body as a statement flow (read-only)", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill all the way into Order.confirm — system → module → context → Order →
  // confirm. Use ids so it works regardless of which aggregate sorts first.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="module:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  await page.locator('.react-flow__node[data-id="aggregate:Order"]').click();
  await page.locator('.react-flow__node[data-id="operation:confirm"]').click();

  // The confirm body renders as one stmt node per statement, all visible.
  const stmts = page.getByTestId("c4system-v2-stmt");
  await expect.poll(async () => stmts.count(), { timeout: 5_000 }).toBeGreaterThan(0);
  // Order.confirm in sales-system.ddd has at least one assign and an emit.
  await expect(page.locator('[data-testid="c4system-v2-stmt"][data-stmt-kind="emit"]')).toBeVisible();
  await expect(page.locator('[data-testid="c4system-v2-stmt"][data-stmt-kind="assign"]')).toBeVisible();
});
