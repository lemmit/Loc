// Migrations dock tab e2e: the evolution-lifecycle surface.  Opening the tab
// auto-derives the migration + wire-contract diff of the live source against
// a baseline (both lowered in the build worker via the same pure cores the
// CLI runs), and the Snapshots section captures provenance on demand (the
// playground's `ddd snapshot`).
//
// Pure client-side (build worker + git store) — no network, no backend boot.
// Three tests:
//   1. Smoke — tab → panel → auto-diff → snapshot button wiring (unedited
//      example ⇒ live == baseline ⇒ "no schema changes").
//   2. Edit-driven — add a field, then diff the live edit against an EARLIER
//      pinned baseline (via History's "Diff as baseline") and assert the added
//      column surfaces as a migration.  This exercises the M-T8.11 History→
//      baseline pin AND is debounce-safe: the autosave commits the edit (so a
//      naive live-vs-HEAD diff would be empty), which is exactly why the
//      baseline is pinned to a pre-edit commit.
//   3. Multi-file — a 13-file import workspace (Acme) surfaces the diff instead
//      of the removed single-file gate (both trees now lower via the project
//      loader).

import { expect, test, type Page } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

/** Wipe the playground's IndexedDB so an edit-driven test starts from a clean
 *  commit history (mirrors workspace-history.spec.ts). */
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

// Past the 1.5s autosave-commit debounce (startAutoCommit) so an edit lands
// as its own commit.
const AUTOSAVE_SETTLE_MS = 2200;

test("Migrations tab derives the evolution diff and captures snapshots", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("devtools-tab-migrations").click();

  // The panel mounts and auto-runs the diff on open.
  await expect(page.getByTestId("migrations-panel")).toBeVisible();

  // The baseline picker is present (defaults to "Last save (HEAD)"; earlier
  // commits can be pinned as the baseline).
  await expect(page.getByTestId("evolution-baseline")).toBeVisible();

  // The schema-migration section resolves (auto-diff completed) — with the
  // unedited example the live source matches the baseline, so no migration
  // cards, but the section itself renders.
  await expect(page.getByTestId("evolution-migrations")).toBeVisible({
    timeout: 20_000,
  });

  // Re-running the diff on demand stays wired.
  await page.getByTestId("evolution-refresh").click();
  await expect(page.getByTestId("evolution-migrations")).toBeVisible({
    timeout: 20_000,
  });

  // Snapshot capture runs and reports a result (either captured provenance
  // files or the "no provenanced field" note — both leave the section shown).
  await page.getByTestId("snapshot-capture").click();
  await expect(page.getByTestId("snapshot-section")).toBeVisible();
});

test("editing the source surfaces a migration diff against a pinned baseline", async ({
  page,
}) => {
  await wipeStorage(page);

  // Edit through the automation seam (`window.__loomSetSource`, the same one
  // system-builder/builder-page specs use) — it sets the whole model and
  // dispatches onChange like a real edit, with none of the Monaco
  // viewport/find-widget fragility of synthetic keystrokes.
  await page.waitForFunction(
    () => typeof (window as unknown as { __loomSetSource?: unknown }).__loomSetSource === "function",
  );

  // Baseline commit WITHOUT the new field — a schema-neutral comment prepend,
  // waited past the autosave debounce so it lands as a commit that predates
  // `phone`.  (The boot import may also commit; either way rows.last() is a
  // pre-`phone` baseline.)
  await page.evaluate(() => {
    const w = window as unknown as { __loomSetSource: (t: string) => void; __loomGetSource: () => string };
    w.__loomSetSource(`// evolution-baseline\n${w.__loomGetSource()}`);
  });
  await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

  // Add a `phone` field to the Customer aggregate (which has `email: string`)
  // → a new column + wire field.
  await page.evaluate(() => {
    const w = window as unknown as { __loomSetSource: (t: string) => void; __loomGetSource: () => string };
    w.__loomSetSource(w.__loomGetSource().replace("email: string", "email: string\n        phone: string"));
  });
  // Let the edit autosave-commit: HEAD now == live (both carry `phone`), so a
  // live-vs-HEAD diff would be empty — the diff must be pinned to the earlier
  // baseline instead.  This is the debounce-safe construction.
  await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

  // History → expand the oldest commit (predates `phone`) → "Diff as baseline".
  await page.getByTestId("devtools-tab-history").click();
  const rows = page.getByTestId("history-row");
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(1);
  await rows.last().click();
  await page.getByTestId("history-diff-baseline").first().click();

  // Lands on the Migrations tab with that baseline pinned; the added column
  // shows as a migration card whose rendered SQL mentions the new field.
  await expect(page.getByTestId("migrations-panel")).toBeVisible();
  const card = page.getByTestId("migration-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText(/phone/i);
});

test("multi-file workspace surfaces the evolution diff (no single-file gate)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // A small multi-file import project (`main.ddd` + `shared/money.ddd` +
  // `shared/currency.ddd`) — the same `loadProjectFromVfs` path the flagship
  // Acme uses, but light enough to diff quickly and deterministically.  The old
  // evolution diff lowered a single `parse(text)` per side, so it gated
  // multi-file workspaces behind a note; now both trees lower via the project
  // loader.  `selectExample` waits for the "0 errors" badge, so the workspace is
  // fully seeded before we diff.
  await selectExample(page, /root-level shared types/);

  await page.getByTestId("devtools-tab-migrations").click();
  await expect(page.getByTestId("migrations-panel")).toBeVisible();

  // Drive the diff explicitly rather than racing the on-open auto-run.
  await page.getByTestId("evolution-refresh").click();

  // The diff sections render for the multi-file workspace — reaching the section
  // at all proves the import graph resolved rather than throwing an
  // unresolved-import error (the old single-file behaviour).
  await expect(page.getByTestId("evolution-migrations")).toBeVisible({
    timeout: 30_000,
  });
  // The removed single-file gate note must be gone, and the diff must not have
  // failed on an unresolved import.
  await expect(page.getByText(/supports single-file workspaces/)).toHaveCount(0);
  await expect(page.getByText(/Diff failed/)).toHaveCount(0);
});
