// Service Worker preview path — internet-free coverage.
//
// runtime.spec drives the full pipeline (Generate → Bundle → Boot →
// dispatch → Preview iframe) and exercises the SW path end-to-end,
// but it self-skips on networks that block browser-context esm.sh
// fetches.  This spec validates the SW push + sandbox-serve round
// trip directly — no Generate/Bundle, no esm.sh — so the path
// slice 3 of the SW migration made hot has regression coverage in
// every CI environment.

import { expect, test } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

test("SW push + sandbox URL round-trip without bundling", async ({ page }) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Wait for the SW to reach `activated` and claim this client.
  // App.tsx registers it in its mount effect; up to 10 s for cold
  // installs.
  await page.evaluate(async () => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && (reg.active || navigator.serviceWorker.controller)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("SW did not activate within 10 s");
  });

  // Push a synthetic bundle directly to the SW.  This bypasses the
  // bundler entirely — we're testing the SW message + fetch
  // handlers, not the React bundle pipeline.  MessagePort ack
  // confirms `currentBundle` is in place before we fetch.
  const SENTINEL = "loom-sw-test-sentinel-7c4f1e";
  const ack = await page.evaluate(async (sentinel) => {
    const reg = await navigator.serviceWorker.ready;
    const ctrl = reg.active ?? reg.waiting ?? reg.installing;
    if (!ctrl) return false;
    const html = `<!doctype html><html><body><div id="root">${sentinel}</div></body></html>`;
    return await new Promise<boolean>((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 2_000);
      ch.port1.onmessage = () => {
        clearTimeout(timer);
        resolve(true);
      };
      ctrl.postMessage(
        { type: "loom-sw/set-bundle", bundle: { html, js: "", css: "" } },
        [ch.port2],
      );
    });
  }, SENTINEL);
  expect(ack, "SW acknowledged the bundle push").toBe(true);

  // Now a real navigation fetch to the sandbox URL should be
  // served by the SW with the synthetic HTML — proving the SW
  // intercepts in-scope navigations and serves `currentBundle.html`.
  const result = await page.evaluate(async (sentinel) => {
    const url = new URL("__loom_sandbox__/", location.href).toString();
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.text();
    return { status: res.status, hasSentinel: body.includes(sentinel), url };
  }, SENTINEL);
  expect(result.status).toBe(200);
  expect(result.hasSentinel, `sandbox URL served the pushed bundle (${result.url})`).toBe(
    true,
  );

  // Out-of-prefix paths must NOT be served the sandbox bundle —
  // the SW must let them pass through.  Note: vite preview's SPA
  // fallback returns the playground's `index.html` for unknown
  // paths (status 200), so checking the body doesn't contain our
  // sentinel is the right invariant — over-eager SW interception
  // would swallow that request and return our test bundle instead.
  const outOfPrefix = await page.evaluate(async (sentinel) => {
    const res = await fetch("/some-other-path", { cache: "no-store" });
    const body = await res.text();
    return { status: res.status, hasSentinel: body.includes(sentinel) };
  }, SENTINEL);
  expect(outOfPrefix.hasSentinel, "SW must not intercept out-of-prefix paths").toBe(
    false,
  );
});
