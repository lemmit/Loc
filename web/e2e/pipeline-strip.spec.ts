// The pipeline strip (M-T8.16, audit H1): Validate · Generate · Bundle · Boot
// as one widget whose segments carry state + count and explain a blocker on
// hover.  No network — nothing here bundles or boots; the strip's states are
// driven by the LSP (Validate) and the in-browser generator (Generate), and
// the blocked segments are asserted through their tooltips.

import { expect, test } from "@playwright/test";
import { readEditorSource, waitForPlaygroundReady } from "./_helpers";

function encodeForHash(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

test("after load: Validate=ok, Generate=ok with the file count, Boot blocked with the chain", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  const strip = page.getByTestId("pipeline-strip");
  await expect(strip).toHaveAttribute("data-variant", "segments");

  await expect(page.getByTestId("btn-validate")).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("pipeline-count-validate")).toHaveText("0 errors");

  // Desktop auto-generates shortly after the LSP settles.
  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "ok", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("pipeline-count-generate")).toHaveText(/^\d+ files?$/);

  // Bundle is the next action (enabled, not run); Boot is blocked and says why.
  await expect(page.getByTestId("btn-bundle")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("btn-bundle")).toBeEnabled();
  await expect(page.getByTestId("btn-boot")).toHaveAttribute("data-state", "blocked");
  await expect(page.getByTestId("btn-boot")).toBeDisabled();
  await page.getByTestId("pipeline-segment-boot").hover();
  await expect(page.getByRole("tooltip")).toContainText("Generate, then Bundle, then Boot");

  // The auto-run toggle has a visible label.
  await expect(page.getByText("Auto-run on edit")).toBeVisible();
});

test("Bundle is blocked, with its blocker tooltip, while Generate has not succeeded", async ({ page }) => {
  // An errored source loaded through the share hash: auto-generate never
  // fires on an error count > 0, so there is no generate result at all.
  await page.goto(`/#s=${encodeForHash("system Broken {\n  module M {\n")}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Loom Playground/i })).toBeVisible();

  await expect(page.getByTestId("btn-validate")).toHaveAttribute("data-state", "failed", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "blocked");
  await expect(page.getByTestId("btn-bundle")).toHaveAttribute("data-state", "blocked");
  await expect(page.getByTestId("btn-bundle")).toBeDisabled();
  await page.getByTestId("pipeline-segment-bundle").hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Generate first — Bundle compiles the generated backend and frontend.",
  );
});

test("a syntax error flips Validate to failed with the count and Generate to blocked", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "ok", {
    timeout: 60_000,
  });

  const src = await readEditorSource(page);
  await page.evaluate(
    (text) => (window as unknown as { __loomSetSource: (t: string) => void }).__loomSetSource(text),
    `${src}\nthis is not loom {\n`,
  );

  await expect(page.getByTestId("btn-validate")).toHaveAttribute("data-state", "failed", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("pipeline-count-validate")).toHaveText(/^[1-9]\d* errors?$/);
  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "blocked");
  await expect(page.getByTestId("btn-generate")).toBeDisabled();
  await page.getByTestId("pipeline-segment-generate").hover();
  await expect(page.getByRole("tooltip")).toContainText(/Fix the \d+ errors? in your source first/);
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the strip renders as dots and More opens the sheet", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("mobile-tabs")).toBeVisible({ timeout: 60_000 });

    const strip = page.getByTestId("pipeline-strip");
    await expect(strip).toHaveAttribute("data-variant", "dots");
    for (const stage of ["validate", "generate", "bundle", "boot"]) {
      await expect(page.getByTestId(`pipeline-dot-${stage}`)).toBeVisible();
    }
    // Mobile has no LSP and no auto-generate on load: nothing has run.
    await expect(page.getByTestId("pipeline-dot-generate")).toHaveAttribute("data-state", "idle");

    // Four primary tabs + More; the secondary panes live in the sheet.
    const tabs = page.getByTestId("mobile-tabs").getByRole("tab");
    await expect(tabs).toHaveCount(5);
    await expect(page.getByTestId("mobile-more-sheet")).toBeHidden();
    await page.getByTestId("mobile-tab-more").click();
    const sheet = page.getByTestId("mobile-more-sheet");
    await expect(sheet).toBeVisible();
    for (const id of ["tests", "migrations", "history", "agent", "auth"]) {
      await expect(sheet.getByTestId(`mobile-tab-${id}`)).toBeVisible();
    }
    await sheet.getByTestId("mobile-tab-tests").click();
    await expect(page.getByTestId("mobile-more-sheet")).toBeHidden();
    await expect(page.getByTestId("mobile-tab-more")).toHaveAttribute("data-secondary-active", "tests");
  });
});
