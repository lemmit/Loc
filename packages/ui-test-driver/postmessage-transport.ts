// Cross-origin driver transport: speaks DriverOps to a sandbox-side
// executor (see serve-driver.ts) over a MessagePort, so the page-object
// spec can run in the parent while the app under test runs in a
// cross-origin iframe.  The wire is the same JSON DriverOp/DriverReply the
// same-origin transport uses; only the hop differs.
//
// Messages are correlated by a numeric `rid` and multiplexed on the port
// by a `kind: "driver"` tag, mirroring the runtime/reload channels the
// preview bridge already runs on the same port.

import type { DriverOp, DriverReply } from "./locator-chain.js";
import type { DriverTransport } from "./remote-page.js";

/** Request envelope posted to the sandbox. */
export interface DriverRequest {
  rid: number;
  kind: "driver";
  op: DriverOp;
}

/** Reply envelope posted back; carries the sandbox's current URL so the
 *  parent can answer the synchronous `page.url()`. */
export type DriverResponse = { rid: number; url?: string } & DriverReply;

export interface PostMessageTransportOptions {
  /** Overall per-op deadline on the parent side; a small margin is added
   *  over the executor's own timeout so the sandbox reports the real
   *  failure first.  Omit to wait indefinitely. */
  timeout?: number;
}

export function makePostMessageTransport(
  port: MessagePort,
  opts?: PostMessageTransportOptions,
): DriverTransport {
  let nextRid = 1;
  const pending = new Map<number, (r: DriverReply) => void>();
  let cachedUrl = "";

  port.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as (DriverResponse & { kind?: string }) | undefined;
    if (!d || typeof d.rid !== "number") return;
    // The port is shared with other channels (e.g. the runtime fetch
    // bridge tags its forwards `kind:"runtime"`). Driver replies carry no
    // `kind`, so ignore anything tagged — its `rid` lives in a different
    // namespace and must not be matched against our pending ops.
    if (d.kind != null) return;
    if (typeof d.url === "string") cachedUrl = d.url;
    const slot = pending.get(d.rid);
    if (!slot) return;
    pending.delete(d.rid);
    slot(
      d.ok
        ? { ok: true, value: d.value }
        : { ok: false, message: d.message },
    );
  });
  port.start?.();

  return {
    currentUrl: () => cachedUrl,
    send(op: DriverOp): Promise<DriverReply> {
      const rid = nextRid++;
      return new Promise<DriverReply>((resolve) => {
        const timer =
          opts?.timeout != null
            ? setTimeout(() => {
                pending.delete(rid);
                resolve({
                  ok: false,
                  message: `driver op timed out after ${opts.timeout}ms (no sandbox reply)`,
                });
              }, opts.timeout + 1000)
            : null;
        pending.set(rid, (r) => {
          if (timer) clearTimeout(timer);
          resolve(r);
        });
        const req: DriverRequest = { rid, kind: "driver", op };
        port.postMessage(req);
      });
    },
  };
}
