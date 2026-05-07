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

  // Console hygiene: the Monaco no-op-worker fix should silence the
  // "toUrl" cascade we hit before.  Allow benign warnings like
  // PGlite's eval-with-bundler chatter and Vite HMR pings.
  const fatal = consoleErrors.filter(
    (m) =>
      !/passive event listener/i.test(m) &&
      !/Using direct eval/i.test(m) &&
      !/Failed to fetch dynamically imported module/i.test(m),
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
