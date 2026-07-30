// Source-file management e2e: adding a `.ddd` file through the real tree UI
// has to have an OBSERVABLE consequence.
//
// The audit's headline finding (docs/audits/playground-file-mgmt-review-2026-07.md
// §1, defects #4/#5) was that it didn't: `createSourceFile` fired an unawaited
// `write`, flipped the active path immediately, scheduled no regenerate, and
// swallowed every rejection to `console.error`.  The user saw a row appear,
// then evaporate.  This spec drives the whole loop the way a person does —
// create, type, reload, import from `main.ddd`, Generate — and asserts the new
// declaration reaches the emitted project.
//
// Pure client-side: the workspace is a git store over LightningFS/IndexedDB
// and Generate runs in the build worker against the in-bundle VFS.  No npm
// install, no bundle, no boot — so this belongs in the per-PR no-network lane.

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { revealTreeRow, selectExample, waitForPlaygroundReady } from "./_helpers";

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

/** The desktop Explorer's "User code" tree.  `explorerMode` is persisted in
 *  localStorage, so pin it rather than trusting the default. */
async function userCodeTree(page: Page): Promise<Locator> {
  await page.getByTestId("explorer-mode").getByText("User code").click();
  const tree = page.getByTestId("source-files-tree");
  await expect(tree).toBeVisible();
  return tree;
}

/** Drive the tree's "+" menu → New file → name → Add. */
async function createFile(page: Page, name: string): Promise<void> {
  await page.getByTestId("source-files-add").click();
  await page.getByTestId("source-files-new-file").click();
  await page.getByTestId("source-files-name").fill(name);
  await page.getByTestId("source-files-submit").click();
}

/** Replace the active editor's whole buffer with `text`.
 *
 *  `text` must be ONE line: the `ddd` language-configuration auto-closes
 *  `{` and `"`, and Monaco's overtype makes a single typed line come out
 *  verbatim — but auto-INDENT would corrupt a multi-line paste-by-typing. */
async function retypeEditor(page: Page, text: string): Promise<void> {
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}

const EXAMPLE = /Multi-file project \(root-level shared types\)/;

test("a file added in the tree persists, survives reload, and reaches Generate", async ({
  page,
}) => {
  await wipeStorage(page);
  // A small multi-file starter: main.ddd already imports two sibling files,
  // so the import we add below is the same shape the example uses.
  await selectExample(page, EXAMPLE);

  const tree = await userCodeTree(page);
  await expect(tree.getByText("main.ddd", { exact: true })).toBeVisible();

  // --- create -----------------------------------------------------------
  await createFile(page, "grade");
  await expect(tree.getByText("grade.ddd", { exact: true })).toBeVisible({ timeout: 10_000 });
  // No error banner: the create actually landed in the store.
  await expect(page.getByTestId("source-files-error")).toHaveCount(0);

  // The create switches the editor to the new file, seeded with the stub.
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toContainText("New file", { timeout: 10_000 });

  // --- type into it -----------------------------------------------------
  await retypeEditor(page, "enum Grade { A, B, C }");
  await expect(editor).toContainText("enum Grade", { timeout: 10_000 });
  // Past the autosave debounce so the git store has the content.
  await page.waitForTimeout(1500);

  // --- survives a reload ------------------------------------------------
  await page.goto("/"); // hash-free, so IDB (not `#s=`) wins the seed race
  await waitForPlaygroundReady(page);
  const tree2 = await userCodeTree(page);
  const gradeRow = tree2.getByText("grade.ddd", { exact: true });
  await expect(gradeRow).toBeVisible({ timeout: 15_000 });
  await gradeRow.click();
  await expect(page.locator(".monaco-editor").first()).toContainText("enum Grade", {
    timeout: 15_000,
  });

  // --- import it from main.ddd and Generate -----------------------------
  await tree2.getByText("main.ddd", { exact: true }).click();
  const mainEditor = page.locator(".monaco-editor").first();
  await expect(mainEditor).toContainText("system MultiFileStore", { timeout: 15_000 });
  await mainEditor.click();
  await page.keyboard.press("Control+Home");
  // Auto-closing `"` + Monaco's overtype cancel out, so this lands verbatim.
  await page.keyboard.type('import "./grade.ddd"\n');
  await expect(mainEditor).toContainText("./grade.ddd", { timeout: 10_000 });

  // The import must RESOLVE — a dangling one is an LSP error, and any error
  // disables Generate.
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });

  // --- the emitted project reflects the new file ------------------------
  await page.getByTestId("explorer-mode").getByText("Generated").click();
  const generated = page.getByTestId("explorer-tree");
  const voRow = await revealTreeRow(page, generated, "value-objects.ts");
  await voRow.click();
  // Root-level enums are ambient across every context, so `Grade` lands at
  // the top of the deployable's value-objects module — first viewport, no
  // Monaco virtualization to scroll past.
  await expect(page.getByTestId("file-viewer")).toContainText("Grade", { timeout: 15_000 });
});

test("the create form rejects a duplicate name instead of silently no-op'ing", async ({
  page,
}) => {
  await wipeStorage(page);
  await selectExample(page, EXAMPLE);
  await userCodeTree(page);

  await page.getByTestId("source-files-add").click();
  await page.getByTestId("source-files-new-file").click();
  await page.getByTestId("source-files-name").fill("main");

  await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("source-files-submit")).toBeDisabled();
});
