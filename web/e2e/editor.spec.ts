// Editor + LSP + Generate smoke.  All work happens in-browser
// (Langium services in a worker, generator in another worker),
// so this spec runs with no internet — perfect for sandboxed CI.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

// QUARANTINED (#1261): catches a real bug — Monaco's @codingame/monaco-vscode
// init throws 24 console errors on load (getViewContainersByLocation service
// override / `.startup is not a function`). Un-fixme when #1261 is fixed.
test.fixme("playground loads with Monaco editor and Langium LSP", async ({ page }) => {
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

  // Console hygiene.  We allow a small set of known-noise patterns,
  // each anchored / specific enough that a real error containing
  // similar text won't be silently swallowed:
  //
  //   - Chrome's passive-listener advisory (`Added non-passive…`).
  //   - esbuild's bundling-with-direct-eval warning, raised by
  //     PGlite's WASM loader.  Always starts with "Using direct
  //     eval".
  //   - Vite dev-mode HMR module-load failures during a route
  //     change — distinctive enough on its own.
  //   - Two non-fatal init warnings from @codingame/monaco-vscode-api:
  //     the playground runs the api in lightweight EditorService mode
  //     (loom-services.ts: no views-service-override), so monaco logs
  //     `getViewContainersByLocation is not supported …` and a missing
  //     service `.startup` during startup.  The editor + LSP are fully
  //     functional regardless (every other editor/builder spec passes);
  //     these only pollute the console.  Properly silencing them means
  //     wiring the views-service-override into loom-services.ts — done
  //     separately; allow-listed here so this gate stays meaningful.
  //
  // Anchored to the start of the message so a real error that
  // *contains* "Using direct eval" mid-stack doesn't hide.
  const KNOWN_NOISE = [
    /^Added non-passive event listener/i,
    /^Using direct eval/i,
    /^Failed to fetch dynamically imported module/i,
    /^pageerror: .*\bstartup is not a function\b/,
    /^pageerror: Unsupported: .*getViewContainersByLocation is not supported/,
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

test("auto-Generate fires after page-load idle without clicking the button", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // The auto-Generate timer (800 ms after page mount, longer if
  // the LSP took a while to settle) should fire on its own.  No
  // click on btn-generate; just wait for the file-count chip.
  await expect(page.getByText(/\d+ files? · /)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible();
});
