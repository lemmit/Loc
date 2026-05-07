// Editor + LSP + Generate smoke.  All work happens in-browser
// (Langium services in a worker, generator in another worker),
// so this spec runs with no internet — perfect for sandboxed CI.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("playground loads with Monaco editor and Langium LSP", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Sanity: Monaco mounted and the starter source loaded.  Monaco
  // splits each line into per-token spans (often with non-breaking
  // spaces between them), so checking structure + non-empty
  // rendered content is more reliable than substring matches.
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const lineCount = await page
    .locator(".view-lines .view-line")
    .count();
  expect(lineCount, "rendered editor line count").toBeGreaterThan(0);

  // Console hygiene.  We allow exactly three known-noise patterns,
  // each anchored / specific enough that a real error containing
  // similar text won't be silently swallowed:
  //
  //   - Chrome's passive-listener advisory (`Added non-passive…`).
  //   - esbuild's bundling-with-direct-eval warning, raised by
  //     PGlite's WASM loader.  Always starts with "Using direct
  //     eval".
  //   - Vite dev-mode HMR module-load failures during a route
  //     change — distinctive enough on its own.
  //
  // Anchored to the start of the message so a real error that
  // *contains* "Using direct eval" mid-stack doesn't hide.
  const KNOWN_NOISE = [
    /^Added non-passive event listener/i,
    /^Using direct eval/i,
    /^Failed to fetch dynamically imported module/i,
  ];
  const fatal = consoleErrors.filter(
    (m) => !KNOWN_NOISE.some((re) => re.test(m)),
  );
  expect(fatal, "browser console errors during page load").toEqual([]);
});

test("Generate emits a virtual file tree", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("btn-generate").click();
  // Right-pane chip shows file count + generator mode.
  await expect(page.getByText(/\d+ files? · /)).toBeVisible({ timeout: 60_000 });
  // Footer summary.
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible();
});
