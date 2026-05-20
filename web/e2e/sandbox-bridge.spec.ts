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

test("stub handshake → document.write → fetch shim round-trips over the port", async ({
  page,
}) => {
  await page.goto("/");

  // The "bundle": a trivial module that hits the API base and writes
  // the response text into #root.  No imports → no esm.sh needed.
  const appJs = `
    (async () => {
      try {
        const res = await fetch(window.__LOOM_API_BASE__ + "/ping");
        const text = await res.text();
        document.getElementById("root").textContent =
          "BRIDGE:" + res.status + ":" + text;
      } catch (e) {
        document.getElementById("root").textContent = "ERR:" + (e && e.message);
      }
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

  // The shim derived "/ping" as the route (API base prefix stripped)
  // and the parent's reply was reconstructed into a real Response.
  expect(result).toBe("BRIDGE:200:pong /ping");
});
