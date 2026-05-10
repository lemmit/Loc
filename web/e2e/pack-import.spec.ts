// Phase 4 of the IDE refactor: custom design packs in the playground.
//
// This spec drives the actual PackPicker UI in the playground.
// Playwright can't natively upload directories via `setInputFiles`
// (the resulting Files have empty `webkitRelativePath`), so we
// stub `window.showDirectoryPicker` to return a synthetic
// FileSystemDirectoryHandle that yields fixture files.  The
// stub is symmetric with what Chrome's File System Access API
// returns, so the production code path runs unchanged.
//
// Fixture pack lives at `web/test-fixtures/pack-foo/` — a clone
// of the built-in mantine pack with the manifest renamed to
// `foo`.  After import, the user can `design: "./design/foo"`
// in their `.ddd` and the generator picks it up exactly like a
// built-in pack.
//
// No network needed — the spec stops at Generate and asserts
// "generated N files".  Bundle/Boot/Preview would require esm.sh
// (covered by `runtime.spec.ts` and `preview-shadcn.spec.ts`);
// custom-pack semantics live entirely in the worker, before the
// network-required steps.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "..", "test-fixtures", "pack-foo");

interface FixtureEntry {
  name: string;
  content: string;
}

function readFixturePack(): FixtureEntry[] {
  return fs.readdirSync(fixtureDir).flatMap((name) => {
    const full = path.join(fixtureDir, name);
    if (!fs.statSync(full).isFile()) return [];
    return [{ name, content: fs.readFileSync(full, "utf-8") }];
  });
}

test("pack picker → workspace tree → generate against custom design", async ({ page, context }) => {
  await context.clearCookies();
  // Wipe IDB so the test starts from a known state — otherwise a
  // prior run's "Workspace (autosaved)" would shift the editor
  // off the default example and make the design-edit step
  // ambiguous.
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

  // Stub showDirectoryPicker BEFORE navigating, so the picker
  // sees the synthetic API on first render.  addInitScript runs
  // for every navigation in the context.
  const fixtureFiles = readFixturePack();
  await context.addInitScript((files: FixtureEntry[]) => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker =
      async () => {
        return {
          name: "foo",
          async *entries() {
            for (const f of files) {
              yield [
                f.name,
                {
                  kind: "file" as const,
                  async getFile() {
                    return new File([f.content], f.name, {
                      type: "text/plain",
                    });
                  },
                },
              ];
            }
          },
        };
      };
  }, fixtureFiles);

  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Click the Import button — should resolve via the stubbed
  // showDirectoryPicker, walk the synthetic handle, and write
  // every file into the workspace VFS + push to the build worker.
  await page.getByTestId("btn-import-pack").click();

  // The WorkspaceTree component renders a Badge per imported pack;
  // wait for the "foo" badge to appear (proves the import flow
  // ran end-to-end).
  await expect(page.getByTestId("workspace-pack-foo")).toBeVisible({
    timeout: 10_000,
  });

  // Now edit the .ddd to use `design: "./design/foo"`.  Sales-system
  // example has `deployable webApp { ... port: 3001 }` — append
  // the design slot.  Same Monaco-driven keyboard flow used in
  // preview-shadcn.spec.ts.
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+f");
  const findInput = page
    .locator(
      ".monaco-editor .find-widget .find-part textarea, .monaco-editor .find-widget .find-part input",
    )
    .first();
  await findInput.fill("port: 3001");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type('design: "./design/foo"');
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 10_000 });

  // Click Generate.  Worker resolves `design: "./design/foo"` →
  // `/workspace/design/foo` in its VFS, finds pack.json + every
  // template, and produces the same file count Mantine would have.
  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 60_000,
  });
});
