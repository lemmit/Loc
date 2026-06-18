// Sandbox bridge mechanism — no network required.
//
// Exercises the parts the bundling-dependent specs can't reach in a
// network-restricted CI: the static stub announces readiness, accepts
// a transferred MessagePort + synthesised document, `document.write`s
// it, and the inline `fetch` shim survives `document.open()` to
// forward an API request over the port and reconstruct the reply.
//
// This is the no-network gate for Phase 1 of the preview re-platform
// (see docs/playground-sandbox-redesign.md).  It uses the REAL stub
// (`public/sandbox/index.html`) and the REAL synthesised document
// (`makePreviewHtml`), with a hand-rolled parent that mirrors the
// `SandboxBridge` wire protocol and answers `/ping` with a canned
// body.

import { expect, test } from "@playwright/test";
import { makePreviewHtml } from "../src/preview/iframe-html";

test("stub handshake → document.write → fetch shim round-trips, CSP blocks egress", async ({
  page,
}) => {
  await page.goto("/");

  // The "bundle": a trivial module with no imports (so no vendor /
  // network needed).  It (1) hits the API base — must succeed over the
  // bridge despite `connect-src 'none'`, because the shim answers it
  // without touching the network — and (2) attempts an arbitrary
  // cross-origin fetch — must be refused by the CSP before any network
  // attempt, so this passes even where the browser has no egress.
  const appJs = `
    (async () => {
      let api = "apierr";
      try {
        const res = await fetch(window.__LOOM_API_BASE__ + "/ping");
        api = "BRIDGE:" + res.status + ":" + (await res.text());
      } catch (e) { api = "apierr:" + (e && e.message); }
      let ext = "ALLOWED";
      try { await fetch("https://example.com/exfil"); }
      catch (e) { ext = "BLOCKED"; }
      document.getElementById("root").textContent = api + "|ext:" + ext;
    })();
  `;
  const html = makePreviewHtml({ js: appJs, sandboxBase: "/sandbox" });

  const result = await page.evaluate(async (docHtml) => {
    return await new Promise<string>((resolve) => {
      const iframe = document.createElement("iframe");
      // No `sandbox` attribute — mirrors same-origin staging (the
      // boundary is the origin, not the attribute) and keeps
      // contentDocument readable for the assertion below.
      iframe.style.cssText = "width:1px;height:1px;border:0";

      let port: MessagePort | null = null;
      const onWindowMessage = (e: MessageEvent): void => {
        if (e.source !== iframe.contentWindow) return;
        const d = e.data as { type?: string } | undefined;
        if (d?.type !== "loom-stub-ready") return;
        window.removeEventListener("message", onWindowMessage);
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = (ev): void => {
          const m = ev.data as {
            kind?: string;
            rid?: number;
            url?: string;
          };
          if (m?.kind !== "runtime" || typeof m.rid !== "number") return;
          // Canned reply: echo the route the shim derived.
          port!.postMessage({
            rid: m.rid,
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/plain" },
            body: "pong " + m.url,
          });
        };
        iframe.contentWindow!.postMessage(
          { type: "loom-init", html: docHtml },
          location.origin,
          [channel.port2],
        );
      };
      window.addEventListener("message", onWindowMessage);

      // Poll the rewritten document for the shim's result.
      const started = Date.now();
      const poll = setInterval(() => {
        const text =
          iframe.contentDocument?.getElementById("root")?.textContent ?? "";
        if (text) {
          clearInterval(poll);
          resolve(text);
        } else if (Date.now() - started > 8000) {
          clearInterval(poll);
          resolve("TIMEOUT:" + text);
        }
      }, 50);

      iframe.src = "/sandbox/index.html";
      document.body.appendChild(iframe);
    });
  }, html);

  // The shim stripped the runtime base and forwarded "/api/ping" (the
  // SPA's API base now carries the backend's `/api` mount), and the
  // parent's reply was reconstructed into a real Response over the
  // bridge — proving `connect-src 'none'` doesn't break the API path —
  // while the arbitrary cross-origin fetch was refused by the CSP.
  expect(result).toBe("BRIDGE:200:pong /api/ping|ext:BLOCKED");
});

test("loom-reload swaps the bundle in place — document, window and route survive", async ({
  page,
}) => {
  await page.goto("/");

  // First "bundle": stamp a marker on `window` and navigate the app to
  // a sub-route, then render its content into #root.  If a reload were
  // to rewrite the document (the old full-remount behaviour) the marker
  // and the route would be lost.
  const js1 = `
    window.__loom_marker__ = "v1";
    history.pushState(null, "", window.__LOOM_BASENAME__ + "/orders/42");
    document.getElementById("root").textContent = "ONE";
  `;
  // Second "bundle": pushed later over the bridge as a loom-reload.
  // Renders into the fresh #root the controller installs.
  const js2 = `document.getElementById("root").textContent = "TWO";`;

  const html = makePreviewHtml({ js: js1, sandboxBase: "/sandbox" });

  const result = await page.evaluate(
    async ({ docHtml, reloadJs }) => {
      return await new Promise<{
        root: string;
        marker: unknown;
        path: string;
      }>((resolve) => {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:1px;height:1px;border:0";

        const win = (): Window | null => iframe.contentWindow;
        const rootText = (): string =>
          iframe.contentDocument?.getElementById("root")?.textContent ?? "";

        let port: MessagePort | null = null;
        const onWindowMessage = (e: MessageEvent): void => {
          if (e.source !== iframe.contentWindow) return;
          const d = e.data as { type?: string } | undefined;
          if (d?.type !== "loom-stub-ready") return;
          window.removeEventListener("message", onWindowMessage);
          const channel = new MessageChannel();
          port = channel.port1;
          // No runtime forwards expected; keep the port alive.
          port.onmessage = (): void => {};
          iframe.contentWindow!.postMessage(
            { type: "loom-init", html: docHtml },
            location.origin,
            [channel.port2],
          );

          // Once the first bundle has rendered, push the reload and wait
          // for the controller to swap #root to the new bundle.
          const started = Date.now();
          const poll = setInterval(() => {
            if (rootText() === "ONE" && port) {
              port.postMessage({ kind: "reload", js: reloadJs });
              port = null; // push once
            }
            if (rootText() === "TWO") {
              clearInterval(poll);
              resolve({
                root: rootText(),
                marker: (win() as unknown as { __loom_marker__?: unknown })
                  ?.__loom_marker__,
                path: win()?.location.pathname ?? "",
              });
            } else if (Date.now() - started > 8000) {
              clearInterval(poll);
              resolve({
                root: "TIMEOUT:" + rootText(),
                marker: (win() as unknown as { __loom_marker__?: unknown })
                  ?.__loom_marker__,
                path: win()?.location.pathname ?? "",
              });
            }
          }, 50);
        };
        window.addEventListener("message", onWindowMessage);
        iframe.src = "/sandbox/index.html";
        document.body.appendChild(iframe);
      });
    },
    { docHtml: html, reloadJs: js2 },
  );

  // #root now shows the reloaded bundle's output…
  expect(result.root).toBe("TWO");
  // …the window survived (marker intact → no document rewrite / remount)…
  expect(result.marker).toBe("v1");
  // …and the route the user was on is preserved across the reload.
  expect(result.path).toBe("/sandbox/orders/42");
});
