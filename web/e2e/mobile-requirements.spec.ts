// Mobile: the consolidated Code tab exposes Requirements via its
// SegmentedControl.  On a narrow viewport the pane swaps from the
// desktop "tree + detail" side-by-side layout to a master-detail flow
// (tree full-width by default; the detail takes over when a row is
// picked, with a Back button to clear the selection).

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

test("mobile Requirements: tree → detail → back navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(1500);

  // Switch the consolidated tab to Requirements.
  await page.getByTestId("mobile-doc-tab-requirements").click();
  await expect(page.getByTestId("requirements-pane")).toBeVisible({ timeout: 15_000 });

  // The tree fills the pane initially — pick US-001 from the default example.
  const us001 = page.getByTestId("req-row-US-001");
  await expect(us001).toBeVisible({ timeout: 5_000 });
  await us001.click();

  // Detail view replaces the tree; back-button is visible.
  await expect(page.getByTestId("req-detail-US-001")).toBeVisible();
  const back = page.getByTestId("req-back-to-list");
  await expect(back).toBeVisible();

  // Tapping Back clears the selection and returns the user to the tree.
  await back.click();
  await expect(us001).toBeVisible();
  await expect(page.getByTestId("req-detail-US-001")).not.toBeVisible();
});

test("mobile Requirements: opening a Solution shows its detail form", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForTimeout(1500);

  await page.getByTestId("mobile-doc-tab-requirements").click();
  await expect(page.getByTestId("requirements-pane")).toBeVisible({ timeout: 15_000 });

  // Default example (sales-system) declares SOL-001.
  const sol = page.getByTestId("req-row-sol-SOL-001");
  await expect(sol).toBeVisible({ timeout: 5_000 });
  await sol.click();
  await expect(page.getByTestId("sol-detail-SOL-001")).toBeVisible();
  // Back returns to the list.
  await page.getByTestId("req-back-to-list").click();
  await expect(sol).toBeVisible();
});
