// Runtime regression: when the user picks the pinned `mantine@v9`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  Earlier
// PRs in this thread chased symptoms via static analysis (Chakra
// icons, RDC shim, importmap URL form) and missed the duplicate-
// React class of bug because we had no automated runtime gate.
// This spec is that gate — the in-browser npm-install bundler needs the
// npm registry, so it self-skips when the browser sandbox can't reach it
// (same idiom as `runtime.spec.ts`).
//
// What it gates specifically:
// - `dispatcher.getOwner is not a function` (PR #151-#152 hunt)
// - `ReactDOM.createRoot is not a function` (PR #149 hunt)
// - any pageerror surfaced by React-19 rendering the storybook tree

import { expect, test } from "@playwright/test";
import {
  browserCanReachNetwork,
  clickWorkspaceCreate,
  dumpPreviewDiagnostics,
  fatalConsoleErrors,
  waitForBundle,
  waitForPlaygroundReady,
} from "./_helpers";

// #1242 (fixed): the bundle toast asserted "…KB…" but the Hono bundle is
// MB-scale, so the KB-only regex never matched.  The matcher is now
// unit-agnostic ([\d.]+ [KM]?B).
// #1468 (fixed): the boot click then timed out at 45s — not boot-button
// gating but the boot button being *absent*.  The four-region dock defaults
// to the Output tab; `btn-boot` only mounts on the Runtime ("backend") tab,
// so switch to it before booting (same idiom as workspace-history.spec.ts).
test("mantine@v9 preview boots without runtime errors", async ({ page }) => {
  // Capture *every* console error + pageerror surfaced both in the
  // playground host and inside the iframe sandbox.  The iframe shares
  // the page's console (it's same-origin) so a single listener catches
  // both ends.
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Pick the pinned mantine@v9 storybook.  This is the only example
  // that exercises stack v2; the bareword Mantine entry still maps
  // to stack v1 (mantine@v7) until `BUILTIN_PACK_LATEST.mantine`
  // flips in a follow-up PR.
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /Mantine 9 · pinned storybook/ }).click();
  await clickWorkspaceCreate(page);

  // Wait for auto-Generate to populate the file tree.
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });

  if (!(await browserCanReachNetwork(page))) {
    test.skip(
      true,
      "Browser cannot reach the npm registry — Bundle + Preview need network access.  This spec is intended to run on the deployed playground CI step.",
    );
  }

  // Bundle the React frontend.  The in-browser npm install fetches the
  // React 19 runtime and Mantine 9 — ~140 modules; first cold run ~30 s.
  await page.getByTestId("btn-bundle").click();
  await waitForBundle(page);

  // Boot the Hono backend — PGlite WASM + .data come from jsdelivr.  The boot
  // button lives on the dock's Runtime tab (not the default Output tab), so
  // switch to it first — otherwise btn-boot never mounts.
  await page.getByTestId("devtools-tab-backend").click();
  await page.getByTestId("btn-boot").click();
  await expect(page.getByTestId("backend-status")).toHaveText("booted", {
    timeout: 600_000,
  });

  // Switch to Preview.  This is where the iframe loads the bundle
  // and the runtime errors fire if React 19 isn't wired correctly.
  // Preview is always mounted in the four-region shell — no tab to click.
    await expect(page.getByTestId("preview-region")).toBeVisible();
  const iframe = page.frameLocator('[data-testid="preview-iframe"]');

  // First content render — wait for the scaffold Home dashboard's "Welcome"
  // heading (`scaffoldHome`, pack-independent).  The earlier `/Catalog/`-style
  // matcher targeted an aggregate's nav link, which the drawer-based packs
  // (mui/shadcn/chakra) keep in a collapsed sidebar — present in the DOM but
  // not visible — so it timed out despite a fully-rendered landing page.
  try {
    await expect(iframe.getByText(/Welcome/i).first()).toBeVisible({
      timeout: 60_000,
    });
  } catch (e) {
    await dumpPreviewDiagnostics(page, errors, "mantine-v9");
    throw e;
  }

  // Now the gate: no runtime errors during render.  The two
  // failure modes we explicitly watch for:
  //   - dispatcher.getOwner (two-Reacts duplication)
  //   - ReactDOM.createRoot (default-import vs namespace mismatch)
  // Pageerror-level surfaces both.  We also reject any unexpected
  // console.error — Mantine 9 + React 19 shouldn't emit any at
  // steady state on a happy-path mount.
  const fatal = fatalConsoleErrors(errors);
  expect(fatal, "iframe runtime errors during mantine@v9 mount").toEqual([]);
});
