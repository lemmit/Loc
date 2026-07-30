// Model builder — OVERVIEW mode.
//
// The successor to `system-builder.spec.ts` (M-T8.13 phases 2–4): v1's flat
// whole-system canvas no longer ships as a second editing pane, it is the
// Model pane's read-only root view. The comprehension features that lived
// only there — coverage heatmap, cross-model search + kind filter, grouped
// module/context nesting, the wire-shape (DTO) inspector, persisted hand-drag
// layout — are gated here; every EDITING assertion from the old spec moved to
// `system-builder-v2.spec.ts`, against the surviving mutation surface.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

/** Open Sales System in the Model pane's Overview mode. */
async function openOverview(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Sales System/);
  await page.getByTestId("doc-tab-model").click();
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("c4system-v2-overview-toggle").click();
  await expect(page.getByTestId("c4system-v2-overview-canvas")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => page.locator(".react-flow__node").count(), { timeout: 10_000 })
    .toBeGreaterThan(3);
}

test("renders the whole model as one flat graph, read-only", async ({ page }) => {
  await openOverview(page);

  // One node per construct across every level (modules, aggregates, value
  // objects, repositories, deployables, …) — the thing the drill-down cannot
  // show at once.
  await expect(page.locator('[data-testid="rf__node-aggregate:Order"]')).toBeVisible();
  await expect(page.locator('[data-testid="rf__node-repository:Customers"]')).toBeVisible();
  await expect(page.locator('[data-testid="rf__node-deployable:webApp"]')).toBeVisible();

  // Read-only: no add palette, no rename/delete affordances on a node.
  await expect(page.getByTestId("c4system-v2-add-aggregate")).toHaveCount(0);
  await expect(page.getByTestId("c4system-v2-delete")).toHaveCount(0);
});

test("opening a construct jumps the drill-down to it, ancestors and all", async ({ page }) => {
  await openOverview(page);

  // Select Order → the detail panel names it, `Open ↳` drills.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-v2-overview-selected")).toHaveText("Order");
  await page.getByTestId("c4system-v2-overview-open").click();

  // Back in the navigator, at Order — with the full system → module → context
  // breadcrumb above it, exactly as a hand drill would have built it.
  await expect(page.getByTestId("c4system-v2-pane")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("c4system-v2-crumb-3")).toContainText("Order");
  await expect(page.locator('.react-flow__node[data-id^="operation:"]').first()).toBeVisible();
});

test("searches and kind-filters across the whole model", async ({ page }) => {
  await openOverview(page);

  // A name search reveals a match count and enables Focus; clearing it hides them.
  await page.getByTestId("c4system-v2-search").fill("Order");
  await expect(page.getByTestId("c4system-v2-match-count")).toBeVisible();
  await expect(page.getByTestId("c4system-v2-focus")).toBeEnabled();
  await page.getByTestId("c4system-v2-focus").click();
  await page.getByTestId("c4system-v2-search").fill("");
  await expect(page.getByTestId("c4system-v2-match-count")).toHaveCount(0);
});

test("toggles the traceability coverage overlay", async ({ page }) => {
  await openOverview(page);

  // Off by default; toggling it on reveals the tested/untested legend (the
  // linked model is lowered + enriched async to compute coverage).
  await expect(page.getByTestId("c4system-v2-coverage-legend")).toHaveCount(0);
  await page.getByTestId("c4system-v2-coverage-toggle").click();
  await expect(page.getByTestId("c4system-v2-coverage-legend")).toBeVisible();
  await page.getByTestId("c4system-v2-coverage-toggle").click();
  await expect(page.getByTestId("c4system-v2-coverage-legend")).toHaveCount(0);
});

test("nests constructs into module / context groups when Group is on", async ({ page }) => {
  await openOverview(page);

  // No group containers in the default flat layout; toggling Group adds them.
  const groupNodes = page.locator('.react-flow__node[data-id^="group:"]');
  await expect(groupNodes).toHaveCount(0);
  await page.getByTestId("c4system-v2-group-toggle").click();
  await expect.poll(async () => groupNodes.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  // Toggling off restores the flat layout.
  await page.getByTestId("c4system-v2-group-toggle").click();
  await expect(groupNodes).toHaveCount(0);
});

test("shows the selected aggregate's wire shape (DTO field list)", async ({ page }) => {
  await openOverview(page);

  // Selecting an aggregate computes + shows its canonical wire shape (async
  // lower + enrich); the first field is always the id.
  await page.locator('[data-testid="rf__node-aggregate:Order"]').click();
  await expect(page.getByTestId("c4system-v2-wireshape")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("c4system-v2-wire-field").first()).toContainText("id");
});

test("persists hand-dragged node positions across a reload, and Reset clears them", async ({
  page,
}) => {
  await openOverview(page);

  const node = page.locator('[data-testid="rf__node-aggregate:Order"]');
  // A node's CSS transform is in flow coordinates (pan/zoom lives on the
  // viewport), so it's a stable identity to compare across reload + fitView.
  const transform = (): Promise<string> => node.evaluate((el) => (el as HTMLElement).style.transform);
  const derived = await transform();

  // Drag the node by a screen delta; its transform should change and persist.
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 10 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(derived);
  const dragged = await transform();

  await openOverview(page);
  await expect.poll(transform, { timeout: 10_000 }).toBe(dragged);

  // Reset layout discards the saved position → back to the derived layout.
  await page.getByTestId("c4system-v2-overview-reset-layout").click();
  await expect.poll(transform).toBe(derived);
});
