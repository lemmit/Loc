// Phase 3 of the IDE refactor: workspace edits flow through an
// IDB-backed VFS so they survive reload.  This spec drives the
// editor, types into it, reloads the page, and asserts the source
// comes back via the auto-prepended "Workspace (autosaved)"
// example entry.
//
// No network needed — runs everywhere the playground bundle does.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("editor change → reload → source restored from IDB", async ({ page, context }) => {
  await context.clearCookies();
  // Wipe IDB so the test starts from a known-clean state.
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

  // Type a uniquely identifiable comment into the editor.  Monaco
  // accepts keystrokes when focused; we put the cursor at the top
  // of the document and prepend a marker line.
  const marker = `// loom-persistence-test-${Date.now()}`;
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(marker + "\n");

  // Wait for the IDB flush debounce (~250ms in IdbVfs) plus a
  // small buffer for the worker→IDB round-trip.
  await page.waitForTimeout(800);

  // Reload via the bare playground URL, dropping the `#s=` hash
  // that `scheduleHashSync` wrote during typing.  The hash always
  // wins over IDB (sharing is explicit user intent — see App.tsx
  // boot-order comment); to exercise the IDB-restore path the
  // user has to revisit a hash-free URL.  Same contract as
  // visiting the playground for the first time after closing
  // a shared-link tab.
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // After reload, the example dropdown should have auto-selected
  // "Workspace (autosaved)" — Mantine Select renders the active
  // option's label inside the textbox value, so we read it from
  // there (not from the collapsed listbox, which is `hidden`).
  await expect(page.getByLabel("Choose example")).toHaveValue(
    "Workspace (autosaved)",
    { timeout: 10_000 },
  );

  // The editor's first line should be the marker we typed before
  // reload.  Monaco renders text inside `.view-line` divs.
  const firstLine = page.locator(".monaco-editor .view-line").first();
  await expect(firstLine).toContainText(marker, { timeout: 10_000 });
});
