// Spec sanity-check for the mantine v7 + v9 coexistence in the
// playground.  After Phase 1.2 of pack versioning ships, both the
// bareword `Mantine · aggregate-CRUD storybook` (v7) and the pinned
// `Mantine 9 · pinned storybook` (v9) entries must appear in the
// example picker.  Selecting the pinned entry must generate a
// `package.json` whose dependencies declare React 19 / Mantine 9 —
// independent proof that the pinning mechanic survives end-to-end
// through worker generation, not just CLI smoke.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("playground dropdown lists both Mantine versions", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Open the example combobox.
  await page.getByRole("textbox", { name: /Choose example/i }).click();

  const options = await page.locator('[role="option"]').allInnerTexts();
  expect(options.some((o) => /Mantine 9 · pinned storybook/.test(o))).toBe(true);
  expect(options.some((o) => /Mantine · aggregate-CRUD storybook/.test(o))).toBe(
    true,
  );
});

test("pinned mantine@v9 storybook generates files end-to-end", async ({ page }) => {
  // The actual Mantine 9 / React 19 dep declarations are covered by
  // the LOOM_REACT_BUILD_CASE=…:mantine@v9 shard which runs
  // `tsc --noEmit` against the generated TSX.  This spec just
  // confirms the playground worker can resolve the pinned pack and
  // emit files — independent proof the versioning path survives
  // the worker boundary, not just the CLI smoke.
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /Mantine 9 · pinned storybook/ }).click();

  // Auto-Generate fires ~800ms after the example switch.  The footer
  // updates to "generated N file(s)" when the worker round-trips.
  // Multi-deployable storybooks emit ~60 files; just match the
  // shape, not the count.
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });
});
