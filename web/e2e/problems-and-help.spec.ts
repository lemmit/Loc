// Problems as a teaching surface, the ⌘K palette, first run, the panes'
// Go-to-line (M-T8.18, audit H5 / H7 / M14) — no network.  The LSP worker,
// Monaco and the in-browser generator are all that runs; nothing bundles or
// boots.
//
// Six proofs, one per acceptance line:
//   1. a `loom.bare-aggregate-in-type` row offers **Fix**, and applying it
//      drops the error count to 0 (the mutation-proof assertion);
//   2. `F8` moves the cursor to the problem's line and announces it;
//   3. ⌘K → "Generate" runs generate (the strip's segment goes ok);
//   4. the first-run card shows on a fresh profile and not after dismissal;
//   5. `?` (and the `?` header menu) open the shortcut sheet;
//   6. the Builder tab on a broken source shows *Go to line N*, and clicking
//      it lands on Source at that line.

import { expect, test, type Page } from "@playwright/test";
import { dismissFirstRun, readEditorSource, waitForPlaygroundReady } from "./_helpers";

const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

const BROKEN = "system Broken {\n  module M {\n";

async function setSource(page: Page, source: string): Promise<void> {
  await page.getByTestId("doc-tab-source").click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __loomSetSource?: unknown }).__loomSetSource === "function",
  );
  await page.evaluate(
    (t) => (window as unknown as { __loomSetSource: (s: string) => void }).__loomSetSource(t),
    source,
  );
}

async function openProblems(page: Page): Promise<void> {
  await page.getByTestId("devtools-tab-output").click();
  const select = page.getByTestId("output-stream-select");
  if ((await select.inputValue().catch(() => "")) !== "Problems") {
    await select.click();
    await page.getByRole("option", { name: "Problems" }).click();
  }
}

/** Monaco's active line number, read off the gutter. */
async function activeLine(page: Page): Promise<number> {
  const text = await page.locator(".monaco-editor .active-line-number").first().innerText();
  return Number.parseInt(text.trim(), 10);
}

test("a Problems row with a fix-hint provider offers Fix, and applying it clears the error", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await setSource(page, BARE);
  await expect(page.getByTestId("pipeline-count-validate")).toHaveText("1 error", { timeout: 30_000 });

  await openProblems(page);
  const row = page.locator('[data-testid="problem-row"][data-code="loom.bare-aggregate-in-type"]');
  await expect(row).toBeVisible();
  // The teaching surface: code chip + docs link into the language reference.
  await expect(row.getByTestId("problem-code")).toHaveText("loom.bare-aggregate-in-type");
  await expect(row.getByTestId("problem-docs")).toHaveAttribute(
    "href",
    /language-reference\/04-type-system\.html#x-id--cross-aggregate-references$/,
  );

  await row.getByTestId("problem-fix").click();

  // The fix landed in the source and the LSP re-validated it clean.
  await expect.poll(() => readEditorSource(page)).toContain("customer: Customer id");
  await expect(page.getByTestId("pipeline-count-validate")).toHaveText("0 errors", { timeout: 30_000 });
  await expect(page.getByTestId("problems-empty")).toBeVisible();
});

test("F8 moves the cursor to the problem's line and announces it", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await setSource(page, BARE);
  await expect(page.getByTestId("pipeline-count-validate")).toHaveText("1 error", { timeout: 30_000 });

  // Park the cursor on line 1, away from the problem (line 2).
  await page.getByRole("heading", { name: /Loom Playground/i }).click();
  await page.keyboard.press("F8");

  await expect(page.getByTestId("problem-announcer")).toContainText("Problem 1 of 1, line 2");
  await expect.poll(() => activeLine(page)).toBe(2);
  // Shift+F8 wraps around on a single problem and stays put.
  await page.keyboard.press("Shift+F8");
  await expect(page.getByTestId("problem-announcer")).toContainText("Problem 1 of 1, line 2");
});

test("⌘K opens the palette and Generate runs generate", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  // A fresh model so the generate the palette triggers is observable as a
  // new file count (auto-generate is 5 s behind an edit; the palette is not).
  await setSource(page, BARE);
  await expect(page.getByTestId("pipeline-count-validate")).toHaveText("0 errors", { timeout: 30_000 });

  await page.getByRole("heading", { name: /Loom Playground/i }).click();
  await page.keyboard.press("Control+k");
  const search = page.getByPlaceholder("Type a command…");
  await expect(search).toBeVisible();
  await search.fill("Generate");
  await expect(page.getByRole("button", { name: /^Run Generate/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();

  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "ok", { timeout: 60_000 });
  await expect(page.getByTestId("pipeline-count-generate")).toHaveText(/^\d+ files?$/);
});

test("the first-run card shows on a fresh profile and not after dismissal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Loom Playground/i })).toBeVisible();
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });

  const card = page.getByTestId("first-run-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("first-run-describe")).toBeVisible();
  await expect(card.getByTestId("first-run-example")).toBeVisible();

  // The *Write .ddd* door dismisses and lands in the editor.
  await card.getByTestId("first-run-write").click();
  await expect(card).toBeHidden();
  await expect(page.locator(".monaco-editor textarea.inputarea")).toBeFocused();

  await page.reload();
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("first-run-card")).toHaveCount(0);
});

test("the Examples door opens the examples pane, grouped by concept", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("first-run-example").click();
  await expect(page.getByTestId("examples-pane")).toBeVisible();
  await expect(page.getByTestId("examples-concept-crud")).toBeVisible();
  await expect(page.getByTestId("examples-concept-frontends")).toBeVisible();
  // Nothing opened yet in this profile: every dot is hollow.
  await expect(page.locator('[data-testid="example-row"][data-read]')).toHaveCount(0);
  await dismissFirstRun(page);
});

test("? opens the shortcut sheet, and so does the ? header menu", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByRole("heading", { name: /Loom Playground/i }).click();
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Command palette");
  await expect(sheet).toContainText("Tab indents");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.getByTestId("help-menu").click();
  await expect(page.getByTestId("help-docs")).toHaveAttribute("href", /lemmit\.github\.io\/Loc\/$/);
  await page.getByTestId("help-shortcuts").click();
  await expect(sheet).toBeVisible();
});

test("the Builder tab on a broken source shows Go to line N, which lands on Source at that line", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await setSource(page, BROKEN);
  await expect(page.getByTestId("btn-validate")).toHaveAttribute("data-state", "failed", { timeout: 30_000 });

  await page.getByTestId("doc-tab-builder").click();
  const goto = page.getByTestId("builder-goto-line");
  await expect(goto).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("builder-parse-error")).toContainText("Source has syntax errors");
  const line = Number.parseInt((await goto.innerText()).replace(/\D/g, ""), 10);
  expect(line).toBeGreaterThan(0);

  await goto.click();
  // Landed on Source (the editor is visible again) at the diagnostic's line.
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await expect.poll(() => activeLine(page)).toBe(line);
});
