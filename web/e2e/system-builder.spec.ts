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
  // deployables, …) — there should be several.  Let the initial render + fitView
  // settle to a stable count before editing (reading mid-settle races the
  // re-seed and the autogenerate the edit kicks off).
  const flowNodes = page.locator(".react-flow__node");
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);
  let stable = -1;
  await expect
    .poll(async () => {
      const n = await flowNodes.count();
      const ok = n === stable;
      stable = n;
      return ok ? n : -1;
    })
    .toBeGreaterThan(3);
  const before = await flowNodes.count();

  // Add an aggregate → a node appears and the source stays valid.
  await page.getByTestId("c4system-add-aggregate").click();
  await expect.poll(async () => flowNodes.count()).toBeGreaterThan(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Select the just-added aggregate (deterministic fresh name) and delete it —
  // deleting a leaf removes exactly one node (deleting a module would cascade
  // its whole subtree).  fitView keeps every node inside the canvas, so it's
  // clickable.
  const added = page.locator('[data-testid="rf__node-aggregate:Aggregate1"]');
  await expect(added).toHaveCount(1);
  await added.click();
  await expect(page.getByTestId("c4system-selected-name")).toBeVisible();

  await page.getByTestId("c4system-delete").click();
  await expect.poll(async () => flowNodes.count()).toBe(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("renames a construct (and its references) from the inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  const flowNodes = page.locator(".react-flow__node");
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // Select a node fully inside the canvas (see note above re transformed pane).
  const canvasBox = (await page.getByTestId("c4system-canvas").boundingBox())!;
  const count = await flowNodes.count();
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
      break;
    }
  }
  await expect(page.getByTestId("c4system-selected-name")).toBeVisible();

  // Rename it — relies on a full client-side linked build to follow references.
  const newName = "RenamedNodeXyz";
  await page.getByTestId("c4system-rename-input").fill(newName);
  await page.getByTestId("c4system-rename-apply").click();

  // A node with the new name appears and the source stays valid.
  await expect(page.locator(`[data-testid$=":${newName}"]`)).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("adds, retypes, and deletes an aggregate field from the inspector", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);

  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  // Select an aggregate node that's fully inside the canvas.
  const canvasBox = (await page.getByTestId("c4system-canvas").boundingBox())!;
  const aggNodes = page.locator('.react-flow__node[data-testid^="rf__node-aggregate:"]');
  await expect.poll(async () => aggNodes.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  const aggCount = await aggNodes.count();
  for (let i = 0; i < aggCount; i++) {
    const b = await aggNodes.nth(i).boundingBox();
    const cx = b ? b.x + b.width / 2 : -1;
    const cy = b ? b.y + b.height / 2 : -1;
    if (
      b &&
      cx >= canvasBox.x &&
      cx <= canvasBox.x + canvasBox.width &&
      cy >= canvasBox.y &&
      cy <= canvasBox.y + canvasBox.height
    ) {
      await aggNodes.nth(i).click();
      break;
    }
  }
  await expect(page.getByTestId("c4system-fields")).toBeVisible();

  const rows = page.getByTestId("c4system-field-row");
  const before = await rows.count();

  // Add a field — a row appears, source stays valid, selection is kept.
  await page.getByTestId("c4system-field-add").click();
  await expect.poll(async () => rows.count()).toBe(before + 1);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Retype the new (last) field via its Select.
  await rows.last().getByTestId("c4system-field-type").click();
  await page.getByRole("option", { name: "int", exact: true }).first().click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);

  // Delete it — row count returns to the original, source stays valid.
  await rows.last().getByTestId("c4system-field-delete").click();
  await expect.poll(async () => rows.count()).toBe(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});
