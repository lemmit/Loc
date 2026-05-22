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
// `foo`.  After import, a `design: "./design/foo"` slot in the
// source is resolved by the build worker exactly like a built-in
// pack.
//
// The source is pre-edited and loaded through the playground's
// URL-hash share mechanism (`#s=<base64url(source)>`).  An earlier
// version of this spec used Monaco's Find widget + keyboard
// scripting to inject the design slot interactively; that path was
// timing-fragile and broke entirely once the default example
// switched from `sales-system` (with `port: 3001`) to
// `storybook-components` (no `port:` anchor).  URL-hash bootstrap
// is deterministic regardless of default example or LSP startup
// timing.
//
// No network needed — the spec stops at Generate and asserts
// "generated N files".  Bundle/Boot/Preview would require the npm
// registry (covered by `runtime.spec.ts` and `preview-shadcn.spec.ts`);
// custom-pack semantics live entirely in the worker, before the
// network-required steps.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "..", "test-fixtures", "pack-foo");
const salesSystemPath = path.resolve(
  here,
  "..",
  "src",
  "examples",
  "sales-system.ddd",
);

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

// Mirror of `web/src/util/share.ts:encodeSource` — base64url-encoded
// UTF-8, no `=` padding.  Inlined here so the test isn't coupled to
// importing browser-only utilities through Vite.
function encodeForHash(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

test("pack picker → workspace tree → generate against custom design", async ({ page, context }) => {
  await context.clearCookies();
  // Wipe IDB so the test starts from a known state — otherwise a
  // prior run's "Workspace (autosaved)" would shift the editor off
  // the URL-hash source and make the design-slot test ambiguous.
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

  // Pre-edit Sales System to inject `design: "./design/foo"` next to
  // the `port: 3001` line in the webApp deployable, and load it
  // through the URL-hash share mechanism.  The playground reads
  // `#s=...` on mount and synthesises a "Shared link (from URL)"
  // entry at the top of the example dropdown — exampleId starts as
  // "shared" and stays there because workspace.persistedSource is
  // null after the IDB wipe.
  const salesSystemSource = fs.readFileSync(salesSystemPath, "utf-8");
  const sourceWithDesign = salesSystemSource.replace(
    /(deployable webApp \{[\s\S]*?port: 3001)/,
    '$1\n    design: "./design/foo"',
  );
  expect(
    sourceWithDesign,
    "expected the design slot injection to land — anchor changed?",
  ).toContain('design: "./design/foo"');

  // page.goto with a hash-only URL change doesn't fully reload the
  // page in Chromium (it's treated as an in-page navigation), so the
  // React app stays mounted and never re-reads `window.location.hash`.
  // Set the URL first, then `reload()` to force a clean mount that
  // sees the hash on its first `readHashSource()` call.
  await page.goto("/#s=" + encodeForHash(sourceWithDesign));
  await page.reload();
  await waitForPlaygroundReady(page);
  // The find-and-edit step below anchors on "port: 3001" (from the
  // sales-system fixture).  Pin that example explicitly — default
  // moved when storybook entries went to the top of the dropdown.
  await selectExample(page, /Sales System/);

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

  // LSP only sees the source text — the `design:` slot is
  // syntactically valid regardless of whether the pack actually
  // exists in the workspace VFS yet, so 0 errors is the steady
  // state both before and after the import.
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 10_000 });

  // Click Generate.  Worker resolves `design: "./design/foo"` →
  // `/workspace/design/foo` in its VFS, finds pack.json + every
  // template, and produces the same file count Mantine would have.
  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 60_000,
  });
});
