import { type Page, expect } from "@playwright/test";

// Probe esm.sh from the page context so the test can decide whether
// to exercise the network-dependent bundler/runtime stages.  Some
// CI / sandbox environments allow Node-side network but block
// browser-context cross-origin fetches; instead of failing those
// runs, we skip the network steps cleanly.
//
// The previous probe used `mode: "no-cors"` and checked `r != null`
// — that returns an opaque Response for *any* server reply (including
// 503), so the probe came back true even when esm.sh was rejecting
// requests.  Use a real CORS GET against a tiny known-good URL and
// check `res.ok`; esm.sh sets `access-control-allow-origin: *` on
// every response, so CORS works.  AbortController caps the wait
// when DNS/network is hard-down so the probe doesn't hang the whole
// test against a 60 s default timeout.
export async function browserCanReachEsmSh(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch("https://esm.sh/react@18.3.1?dev=false", {
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
export async function selectExample(page: Page, label: string | RegExp): Promise<void> {
  await page.getByLabel("Choose example").click();
  await page.getByRole("option", { name: label }).first().click();
  // Re-wait for the LSP "0 errors" badge — switching examples
  // re-mounts the editor and re-parses the source, so the badge
  // momentarily flickers to "—" before the new source validates.
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}
