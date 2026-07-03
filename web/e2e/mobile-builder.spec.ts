// Mobile: the consolidated Code tab exposes Source / Builder / Model via a
// SegmentedControl plus a "Generated" chip — the phone counterpart of the
// desktop center pane.  Builder's palette/settings and Model's inspector move
// into bottom drawers on the narrow viewport.  Pure client-side, no network.
//
// The shared waitForPlaygroundReady/selectExample helpers wait on desktop-only
// chrome (the title heading + the footer "0 errors" badge, which is height-0 on
// mobile), so we drive the example picker directly like mobile-run-cascade.

import { type Page, expect, test } from "@playwright/test";
import { clickWorkspaceCreate } from "./_helpers";

test.use({ viewport: { width: 375, height: 812 } });

async function openExample(page: Page, label: RegExp): Promise<void> {
  await page.goto("/");
  await page.waitForTimeout(1500);
  // On mobile a workspace is created from an example via the drawer:
  // open it, choose the starting example, then Create.
  await page.getByTestId("mobile-workspace-button").click();
  await page.getByRole("textbox", { name: "Choose example" }).click();
  await page.getByRole("option", { name: label }).first().click();
  await clickWorkspaceCreate(page);
  await page.waitForTimeout(1500);
}

test("mobile Builder: palette drawer adds a primitive, settings drawer edits it", async ({ page }) => {
  await openExample(page, /Components storybook/);

  // Switch the consolidated tab to Builder via the SegmentedControl.
  await page.getByTestId("mobile-doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // The palette lives in a bottom drawer reachable from the toolbar "Add".
  await page.getByTestId("c4builder-add").click();
  await expect(page.getByTestId("c4palette-Button")).toBeVisible({ timeout: 10_000 });
  const newButton = page.getByTestId("c4node-Button").filter({ hasText: "Button" });
  await expect(newButton).toHaveCount(0);
  await page.getByTestId("c4palette-Button").click();
  // Adding closes the drawer and the primitive lands on the canvas.
  await expect(newButton).toHaveCount(1);

  // Tapping a node auto-opens the settings drawer (tap-select → edit) — the
  // Delete action proves a node is selected and the drawer is showing it.
  await newButton.first().click();
  await expect(page.getByTestId("c4builder-delete")).toBeVisible({ timeout: 10_000 });

  // Close the drawer (its overlay covers the toolbar) and Apply round-trips
  // through the source without breaking it.
  await page.keyboard.press("Escape");
  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("mobile Model: Generated shows the file tree; inspector drawer adds a construct", async ({ page }) => {
  await openExample(page, /Sales System/);

  await page.getByTestId("mobile-doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });

  const flowNodes = page.locator(".react-flow__node");
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);

  // The "Generated" chip switches to the file browser (its mobile layout) —
  // the core "consolidated tab" behaviour.  Done before the drawer interaction
  // so the inspector's modal overlay can't intercept the chip tap.
  await page.getByTestId("mobile-doc-tab-generated").click();
  await expect(page.getByTestId("file-tree-mobile")).toBeVisible({ timeout: 10_000 });

  // Back to the Model: the inspector + construct buttons live in a bottom
  // drawer on mobile.  Adding an aggregate writes back valid source.
  await page.getByTestId("mobile-doc-tab-model").click();
  await expect(page.getByTestId("c4system-canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => flowNodes.count(), { timeout: 10_000 }).toBeGreaterThan(3);
  const before = await flowNodes.count();

  await page.getByTestId("c4system-open-inspector").click();
  await expect(page.getByTestId("c4system-add-aggregate")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("c4system-add-aggregate").click();
  await expect.poll(async () => flowNodes.count()).toBeGreaterThan(before);
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});
