// Workspace history e2e: the git-backed workspace records commits as you
// edit (debounced "autosave workspace"), the History dock tab lists them
// and their per-commit file changes, and "Restore this version" rolls the
// workspace back as a fresh commit.  Also asserts the Output panel exposes
// the generated-conflict stream, and that History is reachable on mobile.
//
// Pure client-side (git store over LightningFS + IndexedDB) — no network.

import { expect, test } from "@playwright/test";
import { focusSourceEditor, waitForPlaygroundReady } from "./_helpers";

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
  // Desktop edits in Monaco, mobile in the plain textarea — mobile ships no
  // editor at all now (M-T8.15).  The history behaviour under test is the
  // same on both, so target whichever this viewport rendered.
  await focusSourceEditor(page);
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

test("Restore this version reverts the visible editor content", async ({ page }) => {
  await wipeStorage(page);

  // A marker that exists ONLY after the SECOND edit, so the oldest commit is
  // always a valid "before" target.
  //
  // The base edit is load-bearing, not padding: opening a fresh workspace does
  // not itself record a commit, so a single edit leaves history with exactly
  // ONE row — and then `rows.count() > 1` below fails (and restoring that lone
  // row would restore the marker itself).  Two edits give a pre-marker commit
  // deterministically, the same shape the sibling "creates a restore commit"
  // test already relies on.
  const marker = `// hist-visible-${Date.now()}`;
  await editAndCommit(page, "// hist-visible-base");
  await editAndCommit(page, marker);
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toContainText(marker, { timeout: 10_000 });

  await page.getByTestId("devtools-tab-history").click();
  const rows = page.getByTestId("history-row");
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(1);

  // Restore the OLDEST commit: it predates the marker no matter which
  // autosave / regenerate commits landed in between (the newest row is
  // the current state and offers no Restore button).
  await rows.last().click();
  await page.getByTestId("history-restore").last().click();
  await page.getByTestId("history-restore-do").last().click();
  await expect(page.getByTestId("history-list")).toContainText("restore to", {
    timeout: 10_000,
  });

  // The fix: the store→editor direction of the sync.  Without it the git
  // tree rolls back but Monaco keeps showing (and owning) the old buffer.
  await expect(editor).not.toContainText(marker, { timeout: 15_000 });

  // …and the next keystroke must not write the pre-restore buffer back.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// after-restore\n");
  await page.waitForTimeout(2200); // past the autosave-commit debounce
  await expect(editor).not.toContainText(marker);
  await page.reload();
  await waitForPlaygroundReady(page);
  await expect(page.locator(".monaco-editor").first()).not.toContainText(marker, {
    timeout: 15_000,
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

    // History lives behind the **More** sheet on mobile (M-T8.16): open it,
    // pick the row (it keeps the `mobile-tab-history` id), and the More tab
    // reports which secondary pane is showing.
    await page.getByTestId("mobile-tab-more").click();
    await page.getByTestId("mobile-tab-history").click();
    await expect(page.getByTestId("mobile-tab-more")).toHaveAttribute(
      "data-secondary-active",
      "history",
    );
    await expect
      .poll(() => page.getByTestId("history-row").count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });
});
