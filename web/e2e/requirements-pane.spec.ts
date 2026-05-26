// Requirements tab — read-only browse + form-driven edit flow.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("Requirements tab renders the requirement tree and shows detail on selection", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-requirements").click();
  await expect(page.getByTestId("requirements-pane")).toBeVisible({ timeout: 10_000 });

  // The default example (sales-system) declares US-001 (UserStory) with
  // AC-001 / AC-002 as children, plus TC-001.  Confirm a root row and a
  // child both render in the tree.
  const us001 = page.getByTestId("req-row-US-001");
  await expect(us001).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("req-row-AC-001")).toBeVisible();

  // Selecting a requirement opens its detail pane on the right.
  await us001.click();
  await expect(page.getByTestId("req-detail-US-001")).toBeVisible();
});

test("New Requirement wizard creates a fresh block and selects it", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-requirements").click();
  await page.getByTestId("req-new-requirement").click();
  // The Mantine Modal root the wizard's `data-testid` lands on has a zero
  // box (it's the overlay container), so we wait on a guaranteed-visible
  // child — the ID input — to confirm the wizard rendered.
  const idInput = page.getByTestId("req-wizard-id");
  await expect(idInput).toBeVisible({ timeout: 10_000 });

  // The ID is required + must validate (letter / ticket form). Mantine
  // forwards `data-testid` directly to the <input>, so we don't drill
  // through a `.locator("input")` child here.
  await idInput.fill("US-999");
  await page.getByTestId("req-wizard-title").fill("New story via wizard");
  await page.getByTestId("req-wizard-requirement-create").click();

  // The new requirement shows up in the tree and is auto-selected, with
  // its detail form on the right.
  await expect(page.getByTestId("req-row-US-999")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("req-detail-US-999")).toBeVisible();

  // And the underlying source carries the new block. The wizard appends at
  // the end of the file — outside Monaco's virtualised viewport — so we read
  // the editor model via the `__loomGetSource` test hook rather than relying
  // on DOM text search, which only sees the lines currently rendered.
  const source = await page.evaluate(
    () => (window as unknown as { __loomGetSource: () => string }).__loomGetSource(),
  );
  expect(source).toContain("requirement US-999 {");
});

test("requirement rows show a live verdict pill from the shared test-results state", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-requirements").click();
  await expect(page.getByTestId("requirements-pane")).toBeVisible({ timeout: 10_000 });

  // With no tests run yet, US-001 has a verifying TC-001 but no result,
  // so the live overlay tags it UNVERIFIED (distinct from UNTESTED).
  const verdict = page.getByTestId("req-verdict-US-001");
  await expect(verdict).toBeVisible({ timeout: 5_000 });
  await expect(verdict).toHaveText(/UNVERIFIED|FAILING|VERIFIED|UNTESTED/);
});

test("editing a requirement title saves it back to the source", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("doc-tab-requirements").click();
  await page.getByTestId("req-row-US-001").click();
  // Mantine's TextInput forwards `data-testid` to the inner <input>, so the
  // testid resolves to the input directly — no `.locator("input")` needed.
  const titleInput = page.getByTestId("req-form-title");
  await expect(titleInput).toBeVisible();
  await titleInput.fill("User can log in (updated by form)");
  await page.getByTestId("req-form-save").click();

  // Round-trip: switch to Source and confirm the new title landed.
  await page.getByTestId("doc-tab-source").click();
  await expect(page.getByText('"User can log in (updated by form)"')).toBeVisible({
    timeout: 5_000,
  });
});
