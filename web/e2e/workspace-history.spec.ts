// Workspace history e2e: the git-backed workspace records commits as you
// edit (debounced "autosave workspace"), the History dock tab lists them
// and their per-commit file changes, and "Restore this version" rolls the
// workspace back as a fresh commit.  Also asserts the Output panel exposes
// the generated-conflict stream, and that History is reachable on mobile.
//
// Pure client-side (git store over LightningFS + IndexedDB) — no network.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

/** Wipe the playground's IndexedDB so each test starts clean (mirrors
 *  workspace-persistence.spec.ts). */
async function wipeStorage(
  page: import("@playwright/test").Page,
  opts: { mobile?: boolean } = {},
): Promise<void> {
  await page.goto("/");
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases?.();
    for (const { name } of dbs ?? []) {
      if (name?.startsWith("loom-")) {
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name!);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    }
  });
  await page.reload();
  // `waitForPlaygroundReady` keys off desktop-only chrome (the title heading +
  // the footer "0 errors" badge, height-0 on mobile); the mobile shell signals
  // ready via its tab bar instead.
  if (opts.mobile) {
    await expect(page.getByTestId("mobile-tabs")).toBeVisible({ timeout: 60_000 });
  } else {
    await waitForPlaygroundReady(page);
  }
}

/** Prepend a marker line and wait past the autosave-commit debounce
 *  (1.5s in startAutoCommit) so a commit lands. */
async function editAndCommit(
  page: import("@playwright/test").Page,
  marker: string,
): Promise<void> {
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(`${marker}\n`);
  await page.waitForTimeout(2200);
}

test("History tab lists autosave commits and their changed files", async ({ page }) => {
  await wipeStorage(page);

  await editAndCommit(page, `// hist-${Date.now()}`);

  await page.getByTestId("devtools-tab-history").click();

  // At least one commit row should appear once the autosave commit lands.
  const rows = page.getByTestId("history-row");
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  // Expanding the newest commit shows the files it changed — main.ddd.
  await rows.first().click();
  await expect(page.getByTestId("history-changes")).toContainText("main.ddd", {
    timeout: 10_000,
  });
});

test("Restore this version creates a restore commit", async ({ page }) => {
  await wipeStorage(page);

  // Two distinct commits so there's a non-head commit to restore to.
  await editAndCommit(page, "// hist-restore-one");
  await editAndCommit(page, "// hist-restore-two");

  await page.getByTestId("devtools-tab-history").click();
  const rows = page.getByTestId("history-row");
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(1);

  // Expand a non-head (older) commit and restore it. The newest row is the
  // current state (no Restore button); the second row offers Restore.
  await rows.nth(1).click();
  await page.getByTestId("history-restore").first().click();
  await page.getByTestId("history-restore-do").first().click();

  // A new milestone commit "restore to <oid>" should appear.
  await expect(page.getByTestId("history-list")).toContainText("restore to", {
    timeout: 10_000,
  });
});

test("Output panel exposes a Conflicts stream", async ({ page }) => {
  await wipeStorage(page);
  await page.getByTestId("devtools-tab-output").click();
  // The stream Select lists Conflicts alongside Problems/Generator/Bundler.
  await page.getByTestId("output-stream-select").click();
  await expect(page.getByRole("option", { name: "Conflicts" })).toBeVisible({
    timeout: 10_000,
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("History is reachable as a mobile tab and lists commits", async ({ page }) => {
    await wipeStorage(page, { mobile: true });
    await editAndCommit(page, `// hist-mobile-${Date.now()}`);

    await page.getByTestId("mobile-tab-history").click();
    await expect(page.getByTestId("mobile-tab-history")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(() => page.getByTestId("history-row").count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });
});
