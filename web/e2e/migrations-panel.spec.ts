// Migrations dock tab e2e: the evolution-lifecycle surface.  Opening the tab
// auto-derives the migration + wire-contract diff of the live source against
// the last-committed baseline (both lowered in the build worker via the same
// pure cores the CLI runs), and the Snapshots section captures provenance on
// demand (the playground's `ddd snapshot`).
//
// Pure client-side (build worker + git store) — no network, no backend boot.
// Deterministic smoke: with the unedited example, live source == baseline, so
// the report renders with "no schema changes"; the assertions lock the wiring
// (tab → panel → auto-diff → snapshot button) rather than a timing-sensitive
// diff.  Richer edit-driven diff assertions are a follow-up (M-T8.11).

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Migrations tab derives the evolution diff and captures snapshots", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("devtools-tab-migrations").click();

  // The panel mounts and auto-runs the diff on open.
  await expect(page.getByTestId("migrations-panel")).toBeVisible();

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
