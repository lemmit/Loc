// Runtime regression: when the user picks the pinned `chakra@v3`
// storybook in the playground and runs the full Bundle + Preview
// pipeline, the iframe must boot without console errors.  Chakra v3
// is the largest pack migration (createSystem theme, compound
// components everywhere, createToaster) and resolves the original
// `@chakra-ui/icons` forwardRef pain point — a static `tsc` pass
// can't prove the v3 component tree actually mounts, so this is the
// runtime gate.  The in-browser npm-install bundler needs the npm
// registry, so it self-skips when the browser sandbox can't reach it
// (same idiom as `runtime.spec.ts`).

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
test("chakra@v3 preview boots without runtime errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  // Diagnostic: count which side of the install path the bundle worker hit
  // for each tarball — same-origin mirror vs external registry. Logged at
  // the end so we can compare against the mirror manifest size (printed by
  // the workflow's mirror-build step) and see whether the bundle is
  // actually using the prebuilt mirror or falling back to the registry.
  // Split registry into packument (metadata, fast) vs tarball (slow miss).
  const mirrorHits: string[] = [];
  const registryPackument: string[] = []; // GET /<pkg> (no /-/)
  const registryTarball: string[] = []; // GET /<pkg>/-/<file>.tgz
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/npm-mirror/")) mirrorHits.push(u);
    else if (u.includes("registry.npmjs.org")) {
      if (u.includes("/-/") || u.endsWith(".tgz")) registryTarball.push(u);
      else registryPackument.push(u);
    } else if (u.endsWith(".tgz")) registryTarball.push(u);
  });

  // Diagnostic: surface EVERY console message + page error, not just errors.
  // The bundle worker logs install/bundle progress through console — without
  // capturing it, a stuck bundle just hangs silently until timeout. We tag
  // each line with its timestamp-since-test-start so we can see where time
  // goes.
  const consoleLog: string[] = [];
  const tTestStart = Date.now();
  const stamp = () => `+${Math.round((Date.now() - tTestStart) / 1000)}s`;
  page.on("console", (msg) => {
    consoleLog.push(`[${stamp()} ${msg.type()}] ${msg.text().slice(0, 200)}`);
  });

  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Pick the pinned chakra@v3 storybook.  The bareword Chakra entry
  // still maps to chakra@v2 until `BUILTIN_PACK_LATEST.chakra` flips
  // in a follow-up promote PR.
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /Chakra v3 · aggregate-CRUD storybook/ }).click();
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

  const tBundleStart = Date.now();
  await page.getByTestId("btn-bundle").click();
  try {
    await waitForBundle(page);
  } finally {
    // Always log the install-path breakdown — even on bundle timeout — so
    // we can tell what the worker actually did with its 5 minutes.
    const elapsed = Date.now() - tBundleStart;
    console.log(
      `[chakra-v3] bundle phase elapsed: ${elapsed}ms`,
      `\n  mirror tarballs:    ${mirrorHits.length}`,
      `\n  registry packument: ${registryPackument.length}  (metadata, fast)`,
      `\n  registry tarballs:  ${registryTarball.length}  (mirror MISS — slow)`,
    );
    if (registryTarball.length > 0) {
      console.log(
        "[chakra-v3] missed-from-mirror tarballs (first 15):",
        registryTarball.slice(0, 15).map((u) => u.split("/").slice(-3).join("/")),
      );
    }
    // Snapshot the page so we can see what the UI is showing at the moment
    // of failure — install progress? Bundle progress? An error?
    try {
      await page.screenshot({ path: "test-results/chakra-v3-bundle-timeout.png", fullPage: true });
    } catch { /* best-effort */ }
    // Tail the last 60 console lines from the worker — usually carries the
    // install/bundle progress messages that tell us where time went.
    console.log("[chakra-v3] last 60 console lines:");
    for (const line of consoleLog.slice(-60)) console.log("  " + line);
  }

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
    await dumpPreviewDiagnostics(page, errors, "chakra-v3");
    throw e;
  }

  const fatal = fatalConsoleErrors(errors);
  expect(fatal, "iframe runtime errors during chakra@v3 mount").toEqual([]);
});
