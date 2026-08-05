// The Bundle button must actually START a bundle whenever it is enabled.
//
// It didn't, and the way it failed was the worst kind: the click was a
// complete no-op — no state change, no diagnostic, no network — so
// `waitForBundle` burned its full 600s ceiling and then reported "element(s)
// not found", which says nothing about why.  Every `heavy-preview` spec in
// the post-merge Playground-e2e suite inherited that failure mode (chakra-v3,
// mui-v7, shadcn-v4, mantine-v9, preview-shadcn, runtime), which is why `main`
// went red with a different subset failing each run and some passing on retry.
//
// The race: `GENERATE_DONE` — the dispatch that paints "generated N file(s)"
// and enables the Bundle button — lands BEFORE `runGenerateStep` runs its
// second, sourcemap-carrying generate, and `lastBundleReadyRef` (the input
// `runBundle` reads) was only assigned after that second generate returned.
// Measured on an idle machine: ~700ms.  On a loaded CI runner, seconds.
//
// This spec is the fastest possible statement of the invariant: it clicks
// Bundle the instant the generated text appears — exactly what the heavy
// specs do — and asserts only that the pipeline entered the bundling state.
// It never waits for an npm install, so it needs no network and finishes in
// seconds, which is what lets it gate every PR while the specs it protects
// only run post-merge.

import { expect, test } from "@playwright/test";
import { clickWorkspaceCreate, waitForPlaygroundReady } from "./_helpers";

test("clicking Bundle the moment Generate lands actually starts a bundle", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Let the STARTUP generate settle completely — both passes, not just the
  // one that paints the file count.  Without this the workspace switch below
  // races it, and the startup generate's late write leaves a stale-but-
  // non-null value in the ref, which papers over the window under test (while
  // silently arming Bundle with the PREVIOUS project's tree — the same defect
  // pointing the other way).
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(4_000);

  // The workspace switch is what clears the ref, so the window only opens on
  // this path — the one every heavy spec takes.  The example is picked for
  // SIZE: the wider the generated tree, the longer the second generate and
  // the wider the window.
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: /Choose example/i }).click();
  await page.getByRole("option", { name: /Chakra v3 · aggregate-CRUD storybook/ }).click();
  await clickWorkspaceCreate(page);

  // Click from INSIDE the page, on the animation frame that first shows
  // "generated N file(s)".  A driver-side `locator.click()` costs two round
  // trips plus an actionability check — more than the window on a fast
  // machine, which is exactly why this reproduced only on loaded CI runners
  // and read as flake.  CI widens the window; this narrows the click.  Same
  // race, opposite lever, and this one is deterministic everywhere.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (/generated \d+ file\(s\)/.test(document.body.innerText)) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
    const btn = document.querySelector<HTMLElement>('[data-testid="btn-bundle"]');
    if (!btn) throw new Error("btn-bundle not in the DOM when Generate landed");
    btn.click();
  });

  // The bundle has STARTED — `pipeline.bundling` drives Mantine's `loading`,
  // which renders `data-loading`.  We assert only this, never completion: a
  // bundle that starts and then fails on the network is a different problem
  // and reports itself honestly.  A click that changes nothing at all is
  // this one, and it is invisible without this assertion.
  await expect(page.getByTestId("btn-bundle")).toHaveAttribute(
    "data-loading",
    "true",
    { timeout: 15_000 },
  );
});
