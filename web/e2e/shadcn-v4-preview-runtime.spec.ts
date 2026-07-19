// Runtime regression: when the user picks the pinned `shadcn@v4`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  shadcn@v4
// is the Tailwind 4 migration (CSS-first config, `@tailwindcss/vite`,
// `tw-animate-css`) on stack v2 (React 19) — a static `tsc` pass
// can't prove the CSS pipeline resolves or the tree mounts, so this
// is the runtime gate.  The in-browser npm-install bundler needs the
// npm registry, so it self-skips when the browser sandbox can't reach
// it (same idiom as `runtime.spec.ts`).

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
test("shadcn@v4 preview boots without runtime errors", async ({ page }) => {
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

  // Pick the pinned shadcn@v4 storybook.  The bareword shadcn entry
  // still maps to shadcn@v3 (Tailwind 3) until
  // `BUILTIN_PACK_LATEST.shadcn` flips in a follow-up promote PR.
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /shadcn v4 · aggregate-CRUD storybook/ }).click();
  await clickWorkspaceCreate(page);

  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });

  if (!(await browserCanReachNetwork(page))) {
    test.skip(
      true,
      "Browser cannot reach the npm registry — Bundle + Preview need network access.  This spec is intended to run on the deployed playground CI step.",
    );
  }

  await page.getByTestId("btn-bundle").click();
  await waitForBundle(page);

  // The boot button lives on the dock's Runtime tab (not the default Output
  // tab), so switch to it first — otherwise btn-boot never mounts.
  await page.getByTestId("devtools-tab-backend").click();
  await page.getByTestId("btn-boot").click();
  await expect(page.getByTestId("backend-status")).toHaveText("booted", {
    timeout: 600_000,
  });

  // Preview is always mounted in the four-region shell — no tab to click.
    await expect(page.getByTestId("preview-region")).toBeVisible();
  const iframe = page.frameLocator('[data-testid="preview-iframe"]');

  try {
    await expect(iframe.getByText(/Welcome/i).first()).toBeVisible({
      timeout: 60_000,
    });
  } catch (e) {
    await dumpPreviewDiagnostics(page, errors, "shadcn-v4");
    throw e;
  }

  const fatal = fatalConsoleErrors(errors);
  expect(fatal, "iframe runtime errors during shadcn@v4 mount").toEqual([]);
});
