import { type Page, expect } from "@playwright/test";

// Probe esm.sh from the page context so the test can decide whether
// to exercise the network-dependent bundler/runtime stages.  Some
// CI / sandbox environments allow Node-side network but block
// browser-context cross-origin fetches; instead of failing those
// runs, we skip the network steps cleanly.
export async function browserCanReachEsmSh(page: Page): Promise<boolean> {
  // Only meaningful once we've navigated somewhere with a real
  // origin — about:blank can't issue cross-origin fetches.
  return page.evaluate(async () => {
    try {
      const r = await fetch("https://esm.sh/", { method: "HEAD", mode: "no-cors" });
      return r != null;
    } catch {
      return false;
    }
  });
}

// Wait for the playground to have rendered + the LSP worker to
// have parsed the starter source (visible as the "0 errors" badge).
export async function waitForPlaygroundReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Loom Playground/i })).toBeVisible();
  await expect(page.getByText(/^0 errors$/)).toBeVisible({ timeout: 30_000 });
}
