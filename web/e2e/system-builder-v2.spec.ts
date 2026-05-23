// Model builder v2 — Phase 0 (wiring check). v2 lives behind its own tab while
// it's built up phase by phase; this asserts the tab + source flow are live.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Model v2 tab mounts the v2 pane and reads the current source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-model-v2").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  // The pane parses the current source — at least one System / Module / Context
  // shows a non-zero count on the default example.
  const counts = page.getByTestId(/c4system-v2-count-/);
  await expect.poll(async () => counts.count(), { timeout: 5_000 }).toBeGreaterThan(0);
});
