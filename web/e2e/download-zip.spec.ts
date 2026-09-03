// Export-project-zip e2e: the "Download .zip" action in the Generated
// explorer packages the emitted project tree into a single archive — the
// bridge out of the browser for the backends/frontends the preview can't boot.
//
// Pure client-side (in-memory files → store-only ZIP → blob download). Asserts
// a real download fires and its bytes are a valid ZIP (PK\x03\x04 signature).

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Download .zip exports the generated tree as a valid archive", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Generate so the emitted tree is populated.
  await page.getByTestId("btn-generate").click();

  // Switch the explorer to the Generated tree, where the download lives.
  await page.getByTestId("explorer-mode").getByText("Generated").click();

  const downloadBtn = page.getByTestId("download-zip");
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadBtn.click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  // Local-file-header signature — proves it's a real ZIP, not an empty/HTML blob.
  expect(buf.subarray(0, 4).toString("latin1")).toBe("PK\x03\x04");
  expect(buf.length).toBeGreaterThan(100);

  // The archive carries a ROOT README on running the tree (M-T8.23 slice 3).
  // The ZIP writer is STORE-only, so the entry name and its body are both
  // plain bytes in the archive — no inflate needed to assert on them.
  //
  // The name is matched through its local file header (signature + the 26-byte
  // fixed part) so it pins an entry at the ARCHIVE ROOT: a bare
  // `toContain("README.md")` would also pass on a per-project `api/README.md`
  // the generator emits, which is not what this ships.
  const text = buf.toString("latin1");
  expect(text).toMatch(/PK\x03\x04[\s\S]{26}README\.md/);
  expect(text).toContain("docker compose up --build");
  expect(text).toContain("`.loom/` holds the model's derived views");
});
