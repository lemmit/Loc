// Verifies the in-browser LikeC4 render: generating a system emits
// `.loom/architecture.c4`, and opening it rebuilds + lays out the model
// (Graphviz WASM) and renders an interactive diagram, with a Source toggle.
// Pure client-side — no network needed.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("architecture.c4 renders an interactive LikeC4 diagram", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await test.step("Generate", async () => {
    await page.getByTestId("btn-generate").click();
    await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
  });

  // Open the LikeC4 model file from the generated file tree.  The explorer was
  // split into "User code" / "Generated" segments; emitted files (`.loom/…`)
  // live under the Generated segment, so switch to it first.
  await page.getByTestId("explorer-mode").getByText("Generated").click();
  await page.getByText("architecture.c4", { exact: true }).click();

  // The diagram is built + laid out asynchronously; the LikeC4 canvas
  // renders through xyflow (`.react-flow`).
  const diagram = page.getByTestId("c4-diagram");
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(diagram.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(diagram.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });

  // The hidden `.c4.json` sidecar must not leak into the file tree.
  await expect(page.getByText("architecture.c4.json", { exact: true })).toHaveCount(0);

  // Source toggle drops back to the raw `.c4` text.
  await page.getByTestId("c4-view").getByText("Source").click();
  await expect(page.getByText(/specification \{/)).toBeVisible();
});
