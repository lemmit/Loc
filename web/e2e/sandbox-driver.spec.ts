// Sandbox UI-test driver — no network required.
//
// The unification regression gate: proves the REAL prebuilt sandbox
// driver (public/sandbox/driver.js, loaded via makePreviewHtml's
// driverUrl) attaches serveDriverOps to the bridge port and answers
// DriverOps against the sandbox's own document — i.e. the same path the
// Tests panel now drives through makePostMessageTransport.
//
// It also exercises the real-world hazard: the app fetches (runtime
// channel, kind:"runtime") WHILE driver ops (kind:"driver") are in flight
// on the SAME port.  Their rid counters are independent, so without the
// kind guards in the fetch shim / transport a driver request could be
// mis-handled as a fetch reply (and vice-versa).  Here a click triggers a
// fetch the hand-rolled parent answers, then the driver reads the result
// back — proving the two channels don't cross-talk.
//
// Mirrors sandbox-bridge.spec.ts: real stub + real synthesised document
// with a parent that mirrors the SandboxBridge wire, so no bundling.

import { expect, test } from "@playwright/test";
import { makePreviewHtml } from "../src/preview/iframe-html";

test("sandbox driver drives the DOM while the app fetches over the same port", async ({
  page,
}) => {
  await page.goto("/");

  // No-import "bundle": clicking the button fetches the API base (forwarded
  // over the runtime channel) and writes the reply into #status, then adds
  // a #done marker the driver can wait on.
  const appJs = `
    const root = document.getElementById("root");
    root.innerHTML =
      '<button data-testid="go">Go</button>' +
      '<div data-testid="status">idle</div>';
    root.querySelector('[data-testid="go"]').addEventListener("click", async () => {
      let body = "ERR";
      try {
        const res = await fetch(window.__LOOM_API_BASE__ + "/ping");
        body = await res.text();
      } catch (e) { body = "err:" + (e && e.message); }
      root.querySelector('[data-testid="status"]').textContent = "clicked:" + body;
      const done = document.createElement("div");
      done.setAttribute("data-testid", "done");
      root.appendChild(done);
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
      waitOk?: boolean;
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
          // Runtime channel: answer the app's fetch with a canned reply.
          if (m?.kind === "runtime" && typeof m.rid === "number") {
            port!.postMessage({
              rid: m.rid,
              ok: true,
              status: 200,
              statusText: "OK",
              headers: { "content-type": "text/plain" },
              body: "pong",
            });
            return;
          }
          // Driver channel: replies carry no kind.
          if (m?.kind != null || typeof m?.rid !== "number") return;
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
            // Wait for the bundle to render (and thus driver.js, the next
            // module, to have attached serveDriverOps) before sending ops.
            const ready = await new Promise<boolean>((res) => {
              const t0 = Date.now();
              const iv = setInterval(() => {
                if (iframe.contentDocument?.querySelector('[data-testid="go"]')) {
                  clearInterval(iv);
                  res(true);
                } else if (Date.now() - t0 > 10000) {
                  clearInterval(iv);
                  res(false);
                }
              }, 50);
            });
            if (!ready) {
              resolve({ error: "preview-never-rendered" });
              return;
            }
            const click = await send({
              kind: "locator",
              op: "click",
              chain: [{ k: "getByTestId", id: "go" }],
              timeout: 8000,
            });
            // Auto-wait for the post-fetch marker — proves the runtime
            // round-trip completed alongside the driver channel.
            const wait = await send({
              kind: "locator",
              op: "waitFor",
              chain: [{ k: "getByTestId", id: "done" }],
              state: "visible",
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
              waitOk: wait.ok as boolean,
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
      setTimeout(() => resolve({ error: "timeout" }), 20000);
    });
  }, html);

  // Driver clicked the button → the app's fetch was answered over the
  // runtime channel → the driver waited for the marker and read the status
  // back, all multiplexed on one port without cross-talk.
  expect(result).toEqual({
    clickOk: true,
    waitOk: true,
    status: "clicked:pong",
  });
});
