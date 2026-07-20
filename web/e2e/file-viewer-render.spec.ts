// File-viewer rendering e2e: the Generated explorer must RENDER markdown
// files (not just show their source) and syntax-HIGHLIGHT standard code files.
//
// The `@codingame/monaco-vscode-editor-api` build the playground aliases
// `monaco-editor` onto ships a bare editor with no built-in language modes, so
// generated `.ts` / `.cs` / `.yml` / `.json` files used to render as flat grey
// text.  `loom-services.ts` now registers the standard-language grammars, and
// `FileViewer` gives `.md` a rendered-HTML preview.  This drives both:
//
//   1. open a generated `.loom/*.md` → its rendered preview shows real HTML
//      headings, and the Source toggle drops to a syntax-highlighted view;
//   2. open a generated `.loom/wire-spec.json` → Monaco tokenizes it (proving
//      the grammar registration reaches the read-only file viewer).
//
// Acme is used because its `generate system` output always emits the
// `.loom/` artefact bundle (coverage.md, traceability.md, wire-spec.json …).
// The `.loom` folder sorts first in the tree (leading dot), so its files are
// reliably rendered inside react-arborist's virtualized viewport.

import { expect, test } from "@playwright/test";
import { selectExample, waitForPlaygroundReady } from "./_helpers";

// Count the distinct Monaco token classes (`.mtk1`, `.mtk2`, …) in the active
// read-only viewer.  Untokenized plaintext collapses to a single class; real
// syntax highlighting produces several.
async function distinctMonacoTokenClasses(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const classes = new Set<string>();
    for (const el of document.querySelectorAll('[class*="mtk"]')) {
      for (const c of el.classList) if (/^mtk\d+$/.test(c)) classes.add(c);
    }
    return classes.size;
  });
}

test("Generated explorer renders markdown and highlights code files", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await selectExample(page, /Acme/);

  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });

  // Browse the emitted tree.
  await page.getByTestId("explorer-mode").getByText("Generated").click();
  const tree = page.getByTestId("explorer-tree");

  // 1) Markdown renders as HTML.  coverage.md is always part of the `.loom`
  //    artefact bundle and its report opens with a heading.
  await tree.getByText("coverage.md", { exact: true }).click();
  const preview = page.getByTestId("md-preview");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  // A rendered heading proves marked → HTML ran (raw markdown would show a
  // literal `#`, never an <h*> element).
  await expect(preview.locator("h1, h2, h3").first()).toBeVisible();

  // 2) Syntax highlighting reaches the read-only viewer.  The Source toggle
  //    drops to the Monaco viewer, which — before the grammar registration in
  //    `loom-services.ts` — showed flat, single-class plaintext.  Markdown
  //    registers through the identical textmate path as TS/C#/YAML/JSON, so
  //    tokenizing it into several `.mtk*` classes proves the whole set works.
  await page.getByTestId("md-view").getByText("Source").click();
  await expect
    .poll(() => distinctMonacoTokenClasses(page), { timeout: 15_000 })
    .toBeGreaterThan(1);

  // 3) A standard code file (JSON) is likewise highlighted.  wire-spec.json
  //    sits at the bottom of the `.loom` bundle, which react-arborist
  //    virtualizes out of the initial viewport — scroll the list until the
  //    row mounts, then open it.
  const jsonRow = tree.getByText("wire-spec.json", { exact: true });
  for (let i = 0; i < 80 && (await jsonRow.count()) === 0; i++) {
    await tree.evaluate((el) => {
      const scroller = [el, ...el.querySelectorAll<HTMLElement>("*")].find(
        (n): n is HTMLElement => n instanceof HTMLElement && n.scrollHeight > n.clientHeight + 4,
      );
      scroller?.scrollBy(0, 300);
    });
    await page.waitForTimeout(60);
  }
  await expect(jsonRow).toBeVisible();
  await jsonRow.click();
  await expect
    .poll(() => distinctMonacoTokenClasses(page), { timeout: 15_000 })
    .toBeGreaterThan(1);
});
