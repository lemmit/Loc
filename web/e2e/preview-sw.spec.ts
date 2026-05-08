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

test("SW SPA fallback — deep paths under sandbox prefix serve the bundle HTML", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  await page.evaluate(async () => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && (reg.active || navigator.serviceWorker.controller)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("SW did not activate within 10 s");
  });

  const SENTINEL = "loom-sw-spa-fallback-9d2a";
  await page.evaluate(async (sentinel) => {
    const reg = await navigator.serviceWorker.ready;
    const ctrl = reg.active ?? reg.waiting ?? reg.installing;
    if (!ctrl) throw new Error("no SW controller");
    const html = `<!doctype html><html><body><div id="root">${sentinel}</div></body></html>`;
    await new Promise<void>((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ctrl.postMessage(
        { type: "loom-sw/set-bundle", bundle: { html, js: "", css: "" } },
        [ch.port2],
      );
    });
  }, SENTINEL);

  // Routes the BrowserRouter inside the bundle would land on —
  // SPA fallback has to serve the same HTML so the router can
  // do its thing client-side.  Critically `runtime/*` must NOT
  // be SPA-handled (it's the runtime bridge).
  for (const subpath of ["customers", "products/new", "deeply/nested/path"]) {
    const result = await page.evaluate(
      async ({ subpath, sentinel }) => {
        const url = new URL(`__loom_sandbox__/${subpath}`, location.href).toString();
        const res = await fetch(url, { cache: "no-store" });
        const body = await res.text();
        return {
          status: res.status,
          hasSentinel: body.includes(sentinel),
          contentType: res.headers.get("content-type"),
        };
      },
      { subpath, sentinel: SENTINEL },
    );
    expect(result.status, `SPA fallback for /${subpath}`).toBe(200);
    expect(
      result.contentType,
      `SPA fallback for /${subpath} content-type`,
    ).toContain("text/html");
    expect(
      result.hasSentinel,
      `SPA fallback for /${subpath} returned the bundle HTML`,
    ).toBe(true);
  }
});

test("SW runtime bridge — fetch on `<sandbox>/runtime/*` round-trips through MessagePort", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPlaygroundReady(page);

  // Same SW activation wait as above.
  await page.evaluate(async () => {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && (reg.active || navigator.serviceWorker.controller)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("SW did not activate within 10 s");
  });

  // Attach a synthetic runtime port that echoes requests as JSON
  // — proving the SW forwards the right shape and that the parent's
  // reply makes it back to the in-iframe `fetch()` caller.  No
  // bundler / runtime worker involved.  Then issue an in-page
  // fetch to a sandbox runtime path and validate the response.
  const result = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const ctrl = reg.active ?? reg.waiting ?? reg.installing;
    if (!ctrl) throw new Error("no SW controller");

    // Wire the runtime port BEFORE the fetch, and wait for the
    // SW's `attached` ack so the request can't outrun the attach.
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (data && data.type === "attached") return;
      // Echo: build a JSON body from the forwarded request and
      // send back through the same port.
      const reply = {
        id: data.id,
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          forwardedUrl: data.url,
          forwardedMethod: data.method,
          forwardedBody: data.body,
        }),
      };
      ch.port1.postMessage(reply);
    };
    await new Promise<void>((resolve) => {
      const safety = setTimeout(resolve, 2_000);
      const prev = ch.port1.onmessage;
      ch.port1.onmessage = (ev: MessageEvent) => {
        if (ev.data && ev.data.type === "attached") {
          clearTimeout(safety);
          ch.port1.onmessage = prev;
          resolve();
          return;
        }
        prev?.call(ch.port1, ev);
      };
      ctrl.postMessage({ type: "loom-sw/attach-runtime" }, [ch.port2]);
    });

    // POST to a sandbox runtime URL with a JSON body — should hit
    // the SW, get forwarded over the port, and the echo response
    // should round-trip.
    const url = new URL("__loom_sandbox__/runtime/products", location.href).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "TEST-1" }),
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      json: await res.json(),
    };
  });

  expect(result.status).toBe(200);
  expect(result.contentType).toContain("application/json");
  // The echo body proves the SW forwarded the right URL, method,
  // and body to the port.
  // The forwarded URL must have the sandbox+runtime prefix
  // stripped so the Hono app inside the runtime worker matches
  // its own `/products` route (and not the full deploy path).
  // Origin is preserved; pathname becomes route-relative.
  const forwardedPath = new URL(result.json.forwardedUrl).pathname;
  expect(forwardedPath, "forwarded URL pathname stripped to route").toBe("/products");
  expect(result.json.forwardedUrl).not.toContain("__loom_sandbox__");
  expect(result.json.forwardedMethod).toBe("POST");
  expect(JSON.parse(result.json.forwardedBody)).toEqual({ sku: "TEST-1" });
});
