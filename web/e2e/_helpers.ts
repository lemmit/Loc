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

// Pick a specific example from the header's example dropdown.
// Tests that rely on a particular starter source (sales-system,
// banking-system, …) call this after `waitForPlaygroundReady` so
// the default-example ordering in `examples/index.ts` can change
// without breaking specs.  Mantine's `<Select>` renders the active
// option label inside an accessible-labeled input; clicking it
// opens a listbox of `role="option"` entries.
//
// We target `role="textbox"` with the accessible name (not
// `getByLabel`) because Mantine threads the same `aria-label`
// onto both the underlying `<input>` AND the listbox container —
// `getByLabel` matches both and Playwright's strict mode errors.
// `getByRole("textbox")` limits to the input.
export async function selectExample(page: Page, label: string | RegExp): Promise<void> {
  await page.getByRole("textbox", { name: "Choose example" }).click();
  await page.getByRole("option", { name: label }).first().click();
  // Re-wait for the LSP "0 errors" badge — switching examples
  // re-mounts the editor and re-parses the source, so the badge
  // momentarily flickers to "—" before the new source validates.
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}
