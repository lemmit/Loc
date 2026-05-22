// Sandbox UI-test driver — no network required.
//
// The unification regression gate: proves the REAL prebuilt sandbox
// driver (public/sandbox/driver.js, loaded via makePreviewHtml's
// driverUrl) attaches serveDriverOps to the bridge port and answers
// DriverOps against the sandbox's own document — i.e. the same path the
// Tests panel now drives through makePostMessageTransport, but with a
// hand-rolled parent so it needs no bundling/network.
//
// Mirrors sandbox-bridge.spec.ts: real stub (public/sandbox/index.html) +
// real synthesised document, with a parent that mirrors the SandboxBridge
// handshake and then speaks the kind:"driver" wire.

import { expect, test } from "@playwright/test";
import { makePreviewHtml } from "../src/preview/iframe-html";

test("sandbox driver answers DriverOps over the bridge port (click + read)", async ({
  page,
}) => {
  await page.goto("/");

  // A trivial no-import "bundle": render a button that, when clicked,
  // writes into a status node.  The driver must click it and read back
  // the result entirely over the port.
  const appJs = `
    const root = document.getElementById("root");
    root.innerHTML =
      '<button data-testid="go">Go</button>' +
      '<div data-testid="status">idle</div>';
    root.querySelector('[data-testid="go"]').addEventListener("click", () => {
      root.querySelector('[data-testid="status"]').textContent = "clicked";
    });
  `;
  const html = makePreviewHtml({
    js: appJs,
    sandboxBase: "/sandbox",
    driverUrl: "/sandbox/driver.js",
  });

  const result = await page.evaluate(async (docHtml) => {
    return await new Promise<{
      clickOk?: boolean;
      readOk?: boolean;
      status?: unknown;
      error?: string;
    }>((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:1px;height:1px;border:0";

      let port: MessagePort | null = null;
      let nextRid = 1;
      const pending = new Map<number, (m: Record<string, unknown>) => void>();
      const send = (op: unknown): Promise<Record<string, unknown>> =>
        new Promise((res) => {
          const rid = nextRid++;
          pending.set(rid, res);
          port!.postMessage({ rid, kind: "driver", op });
        });

      const onWindowMessage = (e: MessageEvent): void => {
        if (e.source !== iframe.contentWindow) return;
        const d = e.data as { type?: string } | undefined;
        if (d?.type !== "loom-stub-ready") return;
        window.removeEventListener("message", onWindowMessage);
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = (ev): void => {
          const m = ev.data as Record<string, unknown>;
          if (typeof m?.rid !== "number") return;
          const slot = pending.get(m.rid as number);
          if (!slot) return;
          pending.delete(m.rid as number);
          slot(m);
        };
        iframe.contentWindow!.postMessage(
          { type: "loom-init", html: docHtml },
          location.origin,
          [channel.port2],
        );

        void (async () => {
          try {
            const click = await send({
              kind: "locator",
              op: "click",
              chain: [{ k: "getByTestId", id: "go" }],
              timeout: 8000,
            });
            const read = await send({
              kind: "locator",
              op: "innerText",
              chain: [{ k: "getByTestId", id: "status" }],
              timeout: 8000,
            });
            resolve({
              clickOk: click.ok as boolean,
              readOk: read.ok as boolean,
              status: read.value,
            });
          } catch (err) {
            resolve({ error: String(err) });
          }
        })();
      };
      window.addEventListener("message", onWindowMessage);

      iframe.src = "/sandbox/index.html";
      document.body.appendChild(iframe);
      setTimeout(() => resolve({ error: "timeout" }), 15000);
    });
  }, html);

  // The driver clicked the real button and read the mutated status back —
  // proving serveDriverOps drove the live sandbox DOM over the port.
  expect(result).toEqual({ clickOk: true, readOk: true, status: "clicked" });
});
