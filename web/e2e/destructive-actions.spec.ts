// The confirm / undo layer (M-T8.17, audit H8–H11) — no network.
//
// Four proofs, one per slice:
//   1. a source-file delete arms an INLINE confirm and Cancel keeps the file;
//   2. a declaration delete on the model canvas requires the confirm (Cancel
//      keeps the aggregate — the mutation-proof assertion);
//   3. Undo in the Builder's chrome reverts an Apply and the Source tab shows
//      the reverted text;
//   4. the requirements pane's dirty guard fires when a modified form would
//      be left by a row click.
//
// Pure client-side: the git workspace over IndexedDB, Monaco, the Langium
// worker and the builders — nothing bundles or boots.

import { expect, test, type Page } from "@playwright/test";
import { readEditorSource, waitForPlaygroundReady } from "./_helpers";

/** Wipe the playground's IndexedDB so each test starts on a fresh default
 *  workspace (mirrors source-files.spec.ts). */
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

async function setSource(page: Page, source: string): Promise<void> {
  await page.getByTestId("doc-tab-source").click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __loomSetSource?: unknown }).__loomSetSource === "function",
  );
  await page.evaluate(
    (t) => (window as unknown as { __loomSetSource: (s: string) => void }).__loomSetSource(t),
    source,
  );
}

test("deleting a source file shows the inline confirm; Cancel keeps the file", async ({ page }) => {
  await wipeStorage(page);
  await page.getByTestId("explorer-mode").getByText("User code").click();
  const tree = page.getByTestId("source-files-tree");
  await expect(tree).toBeVisible();

  // A file to delete.
  await page.getByTestId("source-files-add").click();
  await page.getByTestId("source-files-new-file").click();
  await page.getByTestId("source-files-name").fill("scratch");
  await page.getByTestId("source-files-submit").click();
  const row = tree.getByText("scratch.ddd", { exact: true });
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Row kebab → Delete file → the inline row, naming the file, not a dialog.
  const openDelete = async (): Promise<void> => {
    // The kebab is a `span` inside the row button (its label folds into the
    // row's accessible name), so target it by its own label, not by role.
    await tree.getByLabel("Actions for scratch.ddd").click();
    await page.getByRole("menuitem", { name: "Delete file" }).click();
    await expect(page.getByTestId("source-files-delete-confirm")).toBeVisible();
    await expect(page.getByTestId("source-files-delete-confirm")).toContainText("scratch.ddd");
  };
  await openDelete();
  await page.getByTestId("source-files-delete-cancel").click();
  await expect(page.getByTestId("source-files-delete-confirm")).toHaveCount(0);
  // Cancel kept it.
  await expect(row).toBeVisible();

  // Yes deletes it.
  await openDelete();
  await page.getByTestId("source-files-delete-yes").click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("source-files-error")).toHaveCount(0);
});

test("deleting an aggregate on the model canvas requires the confirm", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });

  // Drill: system → subdomain → context, where aggregates are nodes.
  await page.locator('.react-flow__node[data-id^="system:"]').first().click();
  await page.locator('.react-flow__node[data-id^="subdomain:"]').first().click();
  await page.locator('.react-flow__node[data-id^="context:"]').first().click();
  const order = page.locator('[data-construct-kind="aggregate"][data-construct-name="Order"]');
  await expect(order).toBeVisible();

  // × arms the inline confirm ON the node, naming the construct.
  await order.getByTestId("c4system-v2-delete").click();
  const confirm = order.getByTestId("c4system-v2-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("aggregate Order");

  // Cancel: the aggregate is still on the canvas and still in the source.
  await order.getByTestId("c4system-v2-delete-cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(order).toHaveCount(1);
  expect(await readEditorSource(page)).toContain("aggregate Order");

  // Yes: it goes.
  await order.getByTestId("c4system-v2-delete").click();
  await order.getByTestId("c4system-v2-delete-yes").click();
  await expect(order).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(() => readEditorSource(page)).not.toContain("aggregate Order");
});

const BUILDER_SOURCE = `system S {
  ui U {
    page Home {
      body: Heading("Original heading")
    }
  }
}`;

test("Undo in the Builder reverts an Apply and the Source tab shows the reverted text", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await setSource(page, BUILDER_SOURCE);

  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-canvas")).toBeVisible({ timeout: 15_000 });
  // Nothing to undo before the pane has written anything.
  await expect(page.getByTestId("c4builder-undo")).toBeDisabled();

  await page.getByTestId("c4node-Heading").first().click();
  await page.getByTestId("c4builder-prop-text").fill("EDITEDZZZ");
  await page.getByTestId("c4builder-apply").click();
  await expect.poll(() => readEditorSource(page)).toContain("EDITEDZZZ");

  // Undo from the pane's own chrome — no trip to the Source tab.
  await expect(page.getByTestId("c4builder-undo")).toBeEnabled();
  await page.getByTestId("c4builder-undo").click();
  await expect.poll(() => readEditorSource(page)).toContain("Original heading");
  await expect.poll(() => readEditorSource(page)).not.toContain("EDITEDZZZ");
  // The canvas followed the source back.
  await expect(page.getByTestId("c4builder-canvas")).toContainText("Original heading", { timeout: 10_000 });

  // And the Source tab really shows the reverted text.
  await page.getByTestId("doc-tab-source").click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Original", {
    timeout: 10_000,
  });

  // Redo brings the edit back.
  await page.getByTestId("doc-tab-builder").click();
  await expect(page.getByTestId("c4builder-redo")).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId("c4builder-redo").click();
  await expect.poll(() => readEditorSource(page)).toContain("EDITEDZZZ");
});

test("the requirements dirty guard fires when a modified form would be left", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await page.getByTestId("doc-tab-requirements").click();
  await expect(page.getByTestId("requirements-pane")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("req-row-US-001").click();
  await expect(page.getByTestId("req-detail-US-001")).toBeVisible();
  await page.getByTestId("req-form-title").fill("A customer can place an order (edited)");

  // Clicking another row while modified HOLDS the switch behind the confirm.
  await page.getByTestId("req-row-AC-001").click();
  const guard = page.getByTestId("req-select-confirm");
  await expect(guard).toBeVisible();
  await expect(guard).toContainText("US-001");
  await expect(page.getByTestId("req-detail-US-001")).toBeVisible();
  await expect(page.getByTestId("req-detail-AC-001")).toHaveCount(0);

  // Cancel keeps the modified form (the edit is still in the input).
  await page.getByTestId("req-select-cancel").click();
  await expect(guard).toHaveCount(0);
  await expect(page.getByTestId("req-form-title")).toHaveValue(
    "A customer can place an order (edited)",
  );

  // Yes discards it and moves on.
  await page.getByTestId("req-row-AC-001").click();
  await page.getByTestId("req-select-yes").click();
  await expect(page.getByTestId("req-detail-AC-001")).toBeVisible();
  await expect(page.getByTestId("req-detail-US-001")).toHaveCount(0);
});
