// Runtime & evolution surfaces (M-T8.22) — the no-network lane.
//
// Three surfaces the mission re-worded or re-shaped, each provable without
// a bundle or a boot:
//   1. Migrations tab: "Compare with", the auto-run's loading line, a Refresh
//      that keeps its label — and never the copy that told the user to click
//      a button the panel had already pressed (audit M8); the tinted schema
//      diagram renders beside the SQL.
//   2. Tests tab: the verdict legend, and — when discovery fails the way it
//      does in a sandbox with no registry (`Failed to resolve module
//      specifier "uuidv7"`) — one line of interpretation with the raw text
//      folded (audit M9 / M19).
//   3. Output → Diagnostics: a `?crash=pane` entry renders as a sentence,
//      with the ring key kept as a chip (audit M10).
//
// Mutation-proved by reverting `web/src/util/diag-humanize.ts` to return the
// raw reason: test 3's `toContainText("A panel crashed while rendering")`
// fails (see the PR body).

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Migrations tab says Compare with, never 'click Refresh', and draws the tinted diagram", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await page.getByTestId("devtools-tab-migrations").click();
  await expect(page.getByTestId("migrations-panel")).toBeVisible();

  // The picker's label and the button's label (kept while loading).
  await expect(page.getByTestId("evolution-baseline-label")).toHaveText("Compare with");
  await expect(page.getByTestId("evolution-refresh")).toHaveText("Refresh");

  // The contradiction is gone: the diff auto-runs, so no copy asks for a
  // click, and the old picker label is retired.
  await expect(page.getByText(/Click .Refresh diff/)).toHaveCount(0);
  await expect(page.getByText(/^live vs$/)).toHaveCount(0);

  // Either the loading line or the result — never a "click to compute" wall.
  const loading = page.getByTestId("evolution-loading");
  const done = page.getByTestId("evolution-migrations");
  await expect(loading.or(done).first()).toBeVisible({ timeout: 20_000 });
  if (await loading.isVisible()) {
    await expect(loading).toContainText(/Comparing the live source with Last save/);
  }

  // The schema diagram beside the SQL.  The unedited example is either all
  // untouched (dimmed — the baseline commit exists) or all added (green —
  // a fresh workspace has no HEAD yet, so the current source IS the initial
  // schema); the legend counts whichever it is.  Never amber / red: nothing
  // was changed or dropped.
  await expect(done).toBeVisible({ timeout: 30_000 });
  const diagram = page.getByTestId("evolution-diagram");
  await expect(diagram).toBeVisible();
  const tables = diagram.locator('[data-testid="evolution-table"]');
  await expect.poll(() => tables.count()).toBeGreaterThan(0);
  await expect(tables.first()).toHaveAttribute("data-tint", /^(untouched|added)$/);
  await expect(diagram.locator('[data-tint="changed"], [data-tint="removed"]')).toHaveCount(0);
  await expect(page.getByTestId("evolution-tint-legend")).toContainText(/\d+ (untouched|added)/);
  // Copy after the diff, too — the settled state must not say it either.
  await expect(page.getByText(/Click .Refresh diff/)).toHaveCount(0);
});

test("Tests tab shows the verdict legend and interprets the discovery error with the raw text folded", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Discovery reads the generated suites, so Generate first (worker-local,
  // no network).
  await page.getByTestId("btn-generate").click();
  await expect(page.getByText(/generated \d+ file\(s\)/)).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("devtools-tab-tests").click();

  // The legend sits above the requirements rollup (the default example
  // declares requirements), in sentence case, once.
  const legend = page.getByTestId("verdict-legend");
  await expect(legend).toBeVisible({ timeout: 20_000 });
  await expect(legend).toContainText("Untested = no test case covers it");
  await expect(legend).toContainText("Unverified = covered, not yet run");
  await expect(legend).toHaveCount(1);
  // Badges read as words, not the IR enum.
  const verdict = page.getByTestId("req-verdict-US-001");
  await expect(verdict).toBeVisible();
  await expect(verdict).toHaveText(/^(Verified|Failing|Untested|Unverified)$/);

  // Discovery either fails (the sandbox: the generated suite imports a
  // dependency the browser cannot resolve) or lists suites.  On the
  // failure, the interpretation line is up and the raw text is folded.
  const hint = page.getByTestId("test-error-hint");
  const suite = page.locator('[data-testid^="test-suite-"]').first();
  await expect(hint.or(suite).first()).toBeVisible({ timeout: 90_000 });
  if (await hint.isVisible()) {
    await expect(hint).toContainText(/Test discovery needs the generated project's dependencies/);
    await expect(hint).toContainText(/Generate, then Bundle first/);
    // Folded: the raw block is not in the DOM until Show details.
    await expect(page.getByTestId("test-error")).toHaveCount(0);
    await page.getByTestId("test-error-toggle").click();
    await expect(page.getByTestId("test-error")).toBeVisible();
    await expect(page.getByTestId("test-error")).toContainText(/./);
  } else {
    // Discovery succeeded here (deps resolvable) — the rest of this test
    // is the sandbox branch; the legend assertions above are the shared
    // half.
    test.info().annotations.push({
      type: "note",
      description: "test discovery succeeded in this environment; the folded-error branch did not run",
    });
  }
});

test("Diagnostics stream renders a ?crash=pane entry as a sentence, keeping the ring key as a chip", async ({
  page,
}) => {
  await page.goto("/?crash=pane");
  await expect(page.getByTestId("pane-crash-fallback")).toBeVisible();
  await waitForPlaygroundReady(page);

  await page.getByTestId("devtools-tab-output").click();
  await page.getByTestId("output-stream-select").click();
  await page.getByRole("option", { name: "Diagnostics" }).click();

  const list = page.getByTestId("output-diag-list");
  await expect(list).toBeVisible();
  const row = list.locator('[data-testid="output-diag-row"][data-reason="react-error-pane"]').first();
  await expect(row).toBeVisible();
  // The sentence, not the key, is the row's text …
  await expect(row.getByTestId("output-diag-sentence")).toHaveText(
    "A panel crashed while rendering — the rest of the playground kept running.",
  );
  await expect(list).toContainText("A panel crashed while rendering");
  // … and the key is still there for the report / grep.
  await expect(row).toContainText("react-error-pane");
  // Badges read error / snapshot, never the internal key.
  await expect(row.locator(".mantine-Badge-root").first()).toHaveText("error");
});
