import { type Page, expect } from "@playwright/test";

// Probe the npm registry from the page context so the test can decide
// whether to exercise the network-dependent bundle/boot stages.  The
// playground installs real npm tarballs in-browser, so the registry
// is the first external dependency; some CI / sandbox environments
// allow Node-side network but block browser-context cross-origin
// fetches, in which case we skip the network steps cleanly instead of
// failing the run.  A real CORS GET against a tiny known-good URL
// (registry.npmjs.org sets `access-control-allow-origin: *`), with an
// AbortController cap so the probe can't hang the whole test.
export async function browserCanReachNetwork(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch("https://registry.npmjs.org/react/latest", {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  });
}

// Wait for the playground to have rendered + the LSP worker to
// have parsed the starter source (visible as the "0 errors" badge).
export async function waitForPlaygroundReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Loom Playground/i })).toBeVisible();
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}

// Open a specific example.  Examples are now starting points for
// workspaces (not a destructive "replace active" dropdown), so this
// creates a NEW workspace seeded from `label` via the WorkspaceSwitcher
// "+" popover: open it, choose the example, Create.  Tests that rely on
// a particular starter source call this after `waitForPlaygroundReady`.
//
// We target `role="textbox"` with the accessible name (not `getByLabel`)
// because Mantine threads the same `aria-label` onto both the `<input>`
// AND the listbox container; `getByRole("textbox")` limits to the input.
export async function selectExample(page: Page, label: string | RegExp): Promise<void> {
  await page.getByTestId("workspace-new").click();
  await page.getByRole("textbox", { name: "Choose example" }).click();
  await page.getByRole("option", { name: label }).first().click();
  // On slow CI runners Mantine's combobox portal briefly overlays the create
  // button and the dialog re-renders mid-transition, so a single click lands on
  // the closing overlay or a detached node and times out. Retry the click
  // (re-finding the button each time) until the dialog actually closes —
  // `workspace-create` is gone once the workspace is created.
  const create = page.getByTestId("workspace-create");
  await expect(async () => {
    await create.click({ timeout: 10_000 });
    await expect(create).toBeHidden({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  // Re-wait for the LSP "0 errors" badge — the new workspace remounts
  // the editor and re-parses the source, so the badge momentarily
  // flickers to "—" before the new source validates.
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}
