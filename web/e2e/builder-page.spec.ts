// Page-builder MVP (craft.js) end-to-end: open a system with explicit pages,
// switch to the visual Builder, edit a Heading's text, apply, and confirm the
// edit round-trips through the `.ddd` source (the builder re-seeds from the
// rewritten source). Pure client-side — no network.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

test("page builder edits a heading and writes it back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Editing the storybook's top heading.
  const heading = page.getByTestId("c4node-Heading").filter({ hasText: "Loom UI Storybook" });
  await heading.first().click();

  const textInput = page.getByTestId("c4builder-prop-text");
  await expect(textInput).toHaveValue("Loom UI Storybook");
  await textInput.fill("Storybook EDITED");

  // Live canvas reflects the edit immediately (craft setProp).
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Storybook EDITED");

  // Apply regenerates the body and splices it into the source; the builder
  // re-seeds from the rewritten source, so the edit persisting proves the
  // round-trip (emit → splice → re-parse) worked and the source stayed valid.
  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Storybook EDITED");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});

test("palette adds a primitive and writes it back to source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Components storybook/);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });

  // Click the Button chip → a default Button("Button") is added to the body's
  // top container.  Storybook's own buttons render their own labels, so a node
  // reading exactly "Button" is the newly added one.
  const newButton = page.getByTestId("c4node-Button").filter({ hasText: "Button" });
  await expect(newButton).toHaveCount(0);
  await page.getByTestId("c4palette-Button").click();
  await expect(newButton.first()).toBeVisible();

  await page.getByTestId("c4builder-apply").click();
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Button");
  await expect(page.getByText("Source has syntax errors")).toHaveCount(0);
});



