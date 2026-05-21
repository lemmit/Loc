// System / Model Builder (React Flow) end-to-end: open a full system, switch to
// the Model tab, confirm the structural graph renders, then add and delete a
// construct and confirm the edits write back to valid `.ddd` source.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

test("renders the structural graph and edits write back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  // The graph renders one React Flow node per construct (modules, aggregates,
  // deployables, …) — there should be several.
  const flowNodes = page.locator(".react-flow__node");
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);
  const before = await flowNodes.count();

  // Add an aggregate → a node appears and the source stays valid.
  await page.getByTestId("c4system-add-aggregate").click();
  await expect.poll(async () => flowNodes.count()).toBe(before + 1);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Select a node → the inspector shows its name and a Delete action.  React
  // Flow lays nodes out in a transformed/fit-to-view pane, so some sit at the
  // canvas edge; click the first node that falls fully inside the canvas box.
  const canvasBox = (await page.getByTestId("c4system-canvas").boundingBox())!;
  const count = await flowNodes.count();
  let clicked = false;
  for (let i = 0; i < count; i++) {
    const b = await flowNodes.nth(i).boundingBox();
    if (
      b &&
      b.x >= canvasBox.x &&
      b.y >= canvasBox.y &&
      b.x + b.width <= canvasBox.x + canvasBox.width &&
      b.y + b.height <= canvasBox.y + canvasBox.height
    ) {
      await flowNodes.nth(i).click();
      clicked = true;
      break;
    }
  }
  expect(clicked, "a node fully inside the canvas to click").toBe(true);
  await expect(page.getByTestId("c4system-selected-name")).toBeVisible();

  // Delete it → node count drops and the source stays valid.
  await page.getByTestId("c4system-delete").click();
  await expect.poll(async () => flowNodes.count()).toBe(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});
