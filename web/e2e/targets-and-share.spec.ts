// M-T8.23 — the targets drawer, the read-only / embed links, and what the
// share dialog says the link carries.  No network: nothing here bundles or
// boots.  The target change is proved through the SOURCE (the deployable's
// clause is rewritten) and through the pipeline strip's Generate count (the
// regenerate actually ran against the new stack).

import { expect, test } from "@playwright/test";
import { readEditorSource, waitForPlaygroundReady } from "./_helpers";

test("the targets drawer lists the system's deployables with their stack", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.getByTestId("btn-targets").click();
  // Mantine's Drawer root is a zero-size wrapper; its CONTENT is what shows.
  await expect(page.getByRole("heading", { name: "Deployment targets" })).toBeVisible();

  // The starter system ships a Hono backend and a React frontend.
  await expect(page.getByTestId("target-api")).toBeVisible();
  await expect(page.getByTestId("target-webApp")).toBeVisible();
  await expect(page.getByTestId("target-platform-api")).toHaveValue("node");
  await expect(page.getByTestId("target-platform-webApp")).toHaveValue("react");
});

test("switching the frontend target React → Vue rewrites the clause and regenerates", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Wait for the first generate so the file count we compare against is real.
  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "ok", {
    timeout: 60_000,
  });
  const before = await page.getByTestId("pipeline-count-generate").textContent();
  expect(await readEditorSource(page)).toContain("platform: react");

  await page.getByTestId("btn-targets").click();
  await page.getByTestId("target-platform-webApp").click();
  await page.getByRole("option", { name: "vue", exact: true }).click();

  // 1. The source now says vue — the patch landed in the deployable clause,
  //    and the rest of the file is untouched (the Hono backend is still node).
  await expect
    .poll(async () => await readEditorSource(page), { timeout: 30_000 })
    .toContain("platform: vue");
  const source = await readEditorSource(page);
  expect(source).toContain("platform: node");
  expect(source).not.toContain("platform: react");

  // 2. …and the pipeline regenerated against the new stack: a Vue project is
  //    a different tree from a React one, so the file count moves.
  await expect(page.getByTestId("btn-generate")).toHaveAttribute("data-state", "ok", {
    timeout: 60_000,
  });
  await expect
    .poll(async () => await page.getByTestId("pipeline-count-generate").textContent(), {
      timeout: 60_000,
    })
    .not.toBe(before);
});

test("the drawer offers only frontends to a frontend and only backends to a backend", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await page.getByTestId("btn-targets").click();

  await page.getByTestId("target-platform-webApp").click();
  await expect(page.getByRole("option", { name: "vue", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "node", exact: true })).toHaveCount(0);
  // Close the combobox by clicking the drawer's own title — Escape would
  // bubble past the Select and close the whole Drawer.
  await page.getByRole("heading", { name: "Deployment targets" }).click();
  await expect(page.getByRole("option", { name: "vue", exact: true })).toHaveCount(0);

  await page.getByTestId("target-platform-api").click();
  await expect(page.getByRole("option", { name: "java", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "react", exact: true })).toHaveCount(0);
});
