// Requirements tab — read-only browse + form-driven edit flow.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Requirements tab renders the requirement tree and shows detail on selection", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-requirements").click();
  await expect(page.getByTestId("requirements-pane")).toBeVisible({ timeout: 10_000 });

  // The default example (sales-system) declares US-001 (UserStory) with
  // AC-001 / AC-002 as children, plus TC-001.  Confirm a root row and a
  // child both render in the tree.
  const us001 = page.getByTestId("req-row-US-001");
  await expect(us001).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("req-row-AC-001")).toBeVisible();

  // Selecting a requirement opens its detail pane on the right.
  await us001.click();
  await expect(page.getByTestId("req-detail-US-001")).toBeVisible();
});

test("editing a requirement title saves it back to the source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-requirements").click();
  await page.getByTestId("req-row-US-001").click();
  const titleInput = page.getByTestId("req-form-title").locator("input");
  await expect(titleInput).toBeVisible();
  await titleInput.fill("User can log in (updated by form)");
  await page.getByTestId("req-form-save").click();

  // Round-trip: switch to Source and confirm the new title landed.
  await page.getByTestId("doc-tab-source").click();
  await expect(page.getByText('"User can log in (updated by form)"')).toBeVisible({
    timeout: 5_000,
  });
});
