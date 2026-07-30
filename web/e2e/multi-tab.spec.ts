// Multi-tab write coordination (mission M-T8.12) — the whole point of the
// feature, exercised the way it actually breaks: TWO tabs on ONE workspace.
//
// `context.newPage()` gives a second tab inside the SAME browser context, so
// both pages share an origin, an IndexedDB, a `LockManager` and a
// `BroadcastChannel` bus — the exact substrate the feature is built on.  That
// makes the whole mission per-PR-testable without a single network call.
//
// What it asserts, in order:
//   1. Tab A opens the workspace writable (no banner).
//   2. Tab B opens the SAME workspace read-only, with a banner that says so.
//   3. A's edit reaches B live (phase 2 — the invalidation broadcast).
//   4. B takes over: B becomes writable and A visibly flips to read-only —
//      not silently keeping the write role.
//   5. B's edit reaches A (roles really swapped, both directions work).
//
// Pure client-side — the git store is LightningFS over IndexedDB and nothing
// here clicks Generate/Bundle/Boot — so this belongs in the per-PR
// no-network lane.

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

/** Wipe the playground's IndexedDB so each test starts clean (mirrors
 *  workspace-persistence.spec.ts / workspace-history.spec.ts). */
async function wipeStorage(page: Page): Promise<void> {
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
  await waitForPlaygroundReady(page);
}

const banner = (page: Page) => page.getByTestId("workspace-readonly-banner");
const takeOver = (page: Page) => page.getByTestId("workspace-take-over");

/** Prepend a marker line and wait past the autosave-commit debounce (1.5 s in
 *  `startAutoCommit`) so the write is committed AND broadcast. */
async function typeMarker(page: Page, marker: string): Promise<void> {
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(`${marker}\n`);
  await page.waitForTimeout(2200);
}

test("second tab opens read-only, can take over, and both tabs stay live", async ({
  page,
  context,
}) => {
  await wipeStorage(page);
  const a = page;

  // 1. The lone tab owns the writer lock — no banner at all.
  await expect(banner(a)).toHaveCount(0);

  const markerA = `// tab-a-${Date.now()}`;
  await typeMarker(a, markerA);

  // 2. A second tab on the same workspace must NOT become a second writer.
  const b = await context.newPage();
  await b.goto("/");
  await waitForPlaygroundReady(b);

  await expect(banner(b)).toBeVisible({ timeout: 20_000 });
  await expect(banner(b)).toContainText(/another tab/i);
  // A is still the writer.
  await expect(banner(a)).toHaveCount(0);

  // 3. Phase 2 — B is a LIVE reader: A's content reached it.  (B opened after
  // the edit; the next assertion covers an edit made while B is watching.)
  await expect(b.locator(".monaco-editor").first()).toContainText(markerA, {
    timeout: 20_000,
  });

  const markerA2 = `// tab-a-live-${Date.now()}`;
  await typeMarker(a, markerA2);
  await expect(b.locator(".monaco-editor").first()).toContainText(markerA2, {
    timeout: 20_000,
  });

  // 4. Take over from B.  The roles must SWAP — the old holder flipping to
  // read-only is the property that makes this safe; a steal that left A
  // writing would be worse than no lock at all.
  await takeOver(b).click();
  await expect(banner(b)).toHaveCount(0, { timeout: 20_000 });
  await expect(banner(a)).toBeVisible({ timeout: 20_000 });

  // 5. B is genuinely the writer now, and A follows it.
  const markerB = `// tab-b-${Date.now()}`;
  await typeMarker(b, markerB);
  await expect(a.locator(".monaco-editor").first()).toContainText(markerB, {
    timeout: 20_000,
  });

  // …and it is durable, not just on-screen: a fresh load of the workspace
  // sees B's edit rather than A's stale buffer written back over it.
  await b.goto("/");
  await waitForPlaygroundReady(b);
  await expect(b.locator(".monaco-editor").first()).toContainText(markerB, {
    timeout: 20_000,
  });

  await b.close();
});

test("closing the writer tab hands the lock to the survivor", async ({ page, context }) => {
  // The crash-recovery property, tested as a plain close: Web Locks release
  // when the holding context dies, so there is no heartbeat to expire and no
  // stale-lease path to get wrong.
  await wipeStorage(page);
  const a = page;

  const b = await context.newPage();
  await b.goto("/");
  await waitForPlaygroundReady(b);
  await expect(banner(b)).toBeVisible({ timeout: 20_000 });

  await a.close();

  await expect(banner(b)).toHaveCount(0, { timeout: 20_000 });

  // The survivor really can write — the read-only affordances came back too.
  const marker = `// survivor-${Date.now()}`;
  await typeMarker(b, marker);
  await b.goto("/");
  await waitForPlaygroundReady(b);
  await expect(b.locator(".monaco-editor").first()).toContainText(marker, {
    timeout: 20_000,
  });
  await b.close();
});
