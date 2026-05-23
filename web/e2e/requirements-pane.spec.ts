// Requirements tab — Phase 1 (read-only browse).  Asserts the tab is
// wired (next to Source / Builder / Model / Model v2) and that picking a
// requirement on the left brings up its detail on the right.

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
