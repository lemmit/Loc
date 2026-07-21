// Smoke test for the shadcn pack inside the playground preview.
//
// PR #48 wired the Tailwind Play CDN into the iframe and PR #51
// made the pack loader bundle without `node:fs`.  Without an
// end-to-end check, either fix can silently regress — this spec
// loads the pinned shadcn storybook (`design: shadcn`) and drives the
// playground through Generate → Bundle → Boot → Preview, asserting the
// iframe renders shadcn output.
//
// The Generate step alone covers PR #51's regression surface (the
// build worker imports the React generator which transitively
// imports the loader; if the bundled-template glob breaks, Generate
// throws inside the worker).  Bundle/Boot/Preview cover PR #48's
// surface (Tailwind Play CDN injection) and require the npm registry +
// jsdelivr — those steps self-skip when the browser can't reach the
// npm registry, just like runtime.spec.ts.

import { expect, test } from "@playwright/test";
import {
  browserCanReachNetwork,
  fatalConsoleErrors,
  selectExample,
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
test("shadcn design pack → generate → bundle → boot → preview boots", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await waitForPlaygroundReady(page);
  // Load the pinned shadcn storybook — already `design: shadcn` — rather than
  // editing the source live.  Driving the Monaco find widget to inject the
  // slot was deterministically flaky on CI headless (the find widget never
  // opened → a 45s timeout), and the sibling storybook preview specs
  // (chakra/mui/shadcn-v4) prove the pre-designed-example path is robust there.
  await selectExample(page, /shadcn · aggregate-CRUD storybook/);

  await test.step("Generate (build worker imports the bundled template loader)", async () => {
    // This is the regression check for PR #51 specifically: the build
    // worker imports the React generator, which transitively imports
    // `loader-fs.js`.  Without the Vite-glob shim, the worker would
    // crash on first Generate with "node:fs externalised".  No
    // network access required.
    await page.getByTestId("btn-generate").click();
    await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  });

  if (!(await browserCanReachNetwork(page))) {
    test.skip(true, "browser cannot reach the npm registry — Bundle/Boot/Preview steps need network");
  }

  await test.step("Bundle", async () => {
    await page.getByTestId("btn-bundle").click();
    await waitForBundle(page);
  });

  await test.step("Boot", async () => {
    // The boot button lives on the dock's Runtime tab, which isn't the
    // default (Output) — switch to it so btn-boot is actually mounted.
    await page.getByTestId("devtools-tab-backend").click();
    await page.getByTestId("btn-boot").click();
    await expect(page.getByTestId("backend-status")).toHaveText("booted", {
      timeout: 600_000,
    });
  });

  await test.step("Preview renders shadcn output", async () => {
    // Preview is always mounted in the four-region shell — no tab to click.
    await expect(page.getByTestId("preview-region")).toBeVisible();
    const iframe = page.frameLocator('[data-testid="preview-iframe"]');
    // First wait for the iframe to render content — the scaffold Home
    // dashboard's "Welcome" heading is pack-independent and visible on the
    // landing (the aggregate nav sits in a collapsed sidebar for shadcn), so
    // this proves the bundle booted and rendered.
    await expect(iframe.getByText(/Welcome/i).first()).toBeVisible({
      timeout: 60_000,
    });
    // Now prove it's *shadcn*, not Mantine: shadcn's app-shell wraps the
    // layout in a Tailwind `min-h-screen` container (nested under `#root`,
    // not the `#root` div itself).  Mantine's AppShell emits no such Tailwind
    // utility, so the element's mere presence catches a silent
    // fallback-to-Mantine — e.g. if the lowerer ever defaulted an unknown
    // `design:` to `"mantine"` instead of erroring.
    await expect(iframe.locator(".min-h-screen").first()).toBeVisible({ timeout: 10_000 });
  });

  // Same noise filter as runtime.spec.ts.
  const fatal = fatalConsoleErrors(consoleErrors);
  expect(fatal, "browser console errors during shadcn preview run").toEqual([]);
});
