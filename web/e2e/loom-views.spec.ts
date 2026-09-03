// `.loom/` as views, the output diff, and the source ↔ output correspondence
// (M-T8.20) — the no-network lane.
//
// Everything here rides artifacts the build worker already produced, so the
// whole spec runs on a generate alone: no bundle, no boot, no registry.
//
// Acme is the fixture because it is the only example that makes the
// correspondence claim testable: ONE `aggregate Product` is deployed on two
// .NET projects AND a Hono one, so hovering its declaration must light up
// files in three separate generated projects — the "across every target"
// promise, asserted rather than described.  (`test/playground/
// correspondence.test.ts` pins the same mapping headlessly, both directions.)

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  readEditorSource,
  revealTreeRow,
  selectExample,
  waitForPlaygroundReady,
} from "./_helpers";

/** Click Generate and wait for the run to report a file count. */
async function generate(page: Page): Promise<void> {
  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });
}

/** Scroll the source editor until the line containing `text` is mounted, then
 *  put the pointer on it.  Monaco only renders the lines in view, so a hover
 *  helper that does not scroll first silently matches nothing. */
async function hoverEditorLine(page: Page, text: string): Promise<void> {
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 45_000 });
  const line = editor.locator(".view-line").filter({ hasText: text }).first();
  for (let i = 0; i < 60 && (await line.count()) === 0; i++) {
    await editor.hover({ position: { x: 200, y: 200 } });
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await expect(line).toBeVisible();
  await line.hover();
}

test("the .loom/ bundle renders as Diagrams, API and Traceability views", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Acme \(multi-deployable system\)/);
  await generate(page);

  // --- Diagrams: the `.mmd` artifacts, rendered ---------------------------
  await page.getByTestId("explorer-mode-diagrams").click();
  const diagrams = page.getByTestId("diagrams-view");
  await expect(diagrams).toBeVisible();
  // Every system generate emits the same five; the ER diagram is the one the
  // acceptance names.
  const er = page.locator('[data-testid="diagrams-view-row"][data-path=".loom/er.mmd"]');
  await expect(er).toBeVisible();
  await expect(page.getByTestId("diagrams-view-row")).toHaveCount(5);
  await er.click();
  // A rendered <svg>, not the mermaid source — the view exists to render.
  await expect(page.getByTestId("mmd-svg")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("mmd-svg").locator("svg")).toBeVisible();

  // --- API: operations grouped by aggregate -------------------------------
  await page.getByTestId("explorer-mode-api").click();
  const api = page.getByTestId("api-view");
  await expect(api).toBeVisible();
  // Acme declares two aggregates (Product, Order) across two contexts.
  await expect(page.getByTestId("api-group")).toHaveCount(2);
  await expect(
    page.locator('[data-testid="api-group"][data-aggregate="Product"]'),
  ).toBeVisible();
  // The auto-CRUD surface: create, getById, destroy, update, all + the
  // declared `bySku` find.  Asserting a floor rather than an exact count
  // keeps the spec from breaking every time a route arm is added.
  const operations = page.getByTestId("api-operation");
  await expect(async () => {
    expect(await operations.count()).toBeGreaterThanOrEqual(8);
  }).toPass({ timeout: 10_000 });
  await expect(operations.filter({ hasText: "/api/products/{id}" }).first()).toBeVisible();
  // Acme declares no `channel`, and the view says so rather than showing an
  // empty heading.
  await expect(page.getByTestId("api-no-channels")).toBeVisible();

  // --- Traceability: the rendered reports ---------------------------------
  // Acme declares no requirements, so the generator emits no traceability
  // reports for it — only `datasources.md`.  That the view lists exactly what
  // this generate produced (and not a row that opens an empty viewer) is the
  // assertion here; the RENDERING is proven on sales-system below, which does
  // declare requirements.
  await page.getByTestId("explorer-mode-traceability").click();
  await expect(page.getByTestId("traceability-view")).toBeVisible();
  await expect(
    page.locator('[data-testid="traceability-view-row"][data-path=".loom/datasources.md"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="traceability-view-row"][data-path=".loom/coverage.md"]'),
  ).toHaveCount(0);
});

test("the Traceability view renders the requirement reports", async ({ page }) => {
  await page.goto("/");
  // The default workspace is sales-system, the example that declares
  // requirements / solutions / test cases — so this is where the traceability
  // half of the `.loom/` bundle actually exists.
  await waitForPlaygroundReady(page);
  await generate(page);

  await page.getByTestId("explorer-mode-traceability").click();
  await expect(page.getByTestId("traceability-view")).toBeVisible();
  const coverage = page.locator(
    '[data-testid="traceability-view-row"][data-path=".loom/coverage.md"]',
  );
  await expect(coverage).toBeVisible();
  await coverage.click();
  // Rendered HTML, not raw markdown — the whole point of the view.
  await expect(page.getByTestId("md-preview")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("md-preview").locator("h1, h2, h3").first()).toBeVisible();
});

test("hovering a declaration highlights the generated files it produced", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Acme \(multi-deployable system\)/);
  await generate(page);

  // Back to the source editor (opening a view above switches the centre).
  await page.getByTestId("doc-tab-source").click();
  await page.getByTestId("explorer-mode-generated").click();

  await hoverEditorLine(page, "aggregate Product");

  const banner = page.getByTestId("correspondence-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  // The declaration the cursor points at — not the narrower operation the
  // `crudish` token on the same line synthesises.
  await expect(banner).toHaveAttribute("data-construct", "Products.Product");
  // The acceptance bar: at least three generated files light up.  Acme
  // deploys this one aggregate on `api` (.NET), `catalog_api` (.NET) and
  // `catalog_web` (Hono), so the real number is far higher.
  const fileCount = Number(await banner.getAttribute("data-files"));
  expect(fileCount).toBeGreaterThanOrEqual(3);
  await expect(banner).toContainText("Products.Product");

  // The tree marks them too.  The mapping is sticky on mouse-leave (see
  // `EditorPane`), which is what lets the pointer travel to the Explorer
  // without the highlight evaporating — and what makes this assertion
  // possible at all.  The tree is virtualized and `.loom/` sorts first, so a
  // marked row has to be scrolled into existence before it can be counted.
  const tree = page.getByTestId("explorer-tree");
  await revealTreeRow(page, tree, "product.ts");
  await expect(async () => {
    expect(await tree.locator("[data-corresponds]").count()).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 10_000 });

  // Godbolt's colour mapping is a toggle, off by default.  Mantine's Switch
  // hides the real <input> behind its track, so drive it forced and assert on
  // what it PAINTS: per-declaration band decorations in the source editor.
  const toggle = page.getByTestId("colour-map-toggle");
  await expect(toggle).toBeAttached();
  await expect(toggle).not.toBeChecked();
  const bands = page.locator('.monaco-editor [class*="loom-band-"]');
  expect(await bands.count()).toBe(0);
  // Mantine parks the real input off-screen behind its track, so Playwright's
  // own `check()` refuses it ("outside of the viewport"); a DOM click on the
  // checkbox toggles it and fires the change the component listens for.
  await toggle.evaluate((el) => (el as HTMLInputElement).click());
  await expect(toggle).toBeChecked();
  await expect(async () => {
    expect(await bands.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
});

test("the generated tree marks files changed since the last generate", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await selectExample(page, /Acme \(multi-deployable system\)/);

  // First generate: no baseline, so nothing may be marked — flagging a whole
  // tree as "added" the moment it appears is noise, not news.
  await generate(page);
  await page.getByTestId("explorer-mode-generated").click();
  await expect(page.getByTestId("explorer-tree")).toBeVisible();
  await expect(page.getByTestId("explorer-row-status")).toHaveCount(0);

  // Add a field to Product, regenerate: its emitted files must now read as
  // changed on every deployable that hosts it.
  const source = await readEditorSource(page);
  const edited = source.replace("sku: string", "sku: string\n                brand: string");
  expect(edited).not.toBe(source);
  await page.evaluate(
    (text) => (window as unknown as { __loomSetSource: (t: string) => void }).__loomSetSource(text),
    edited,
  );
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
  await generate(page);

  await expect(page.getByTestId("output-diff-summary")).toContainText(/changed/);
  await expect(async () => {
    expect(await page.getByTestId("explorer-row-status").count()).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 15_000 });
});
