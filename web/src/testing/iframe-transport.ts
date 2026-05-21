// Same-origin driver transport: runs each DriverOp in the parent
// against the preview iframe's live document directly.
//
// While the preview is same-origin (staging) the parent can reach
// `iframe.contentDocument`, so no script needs to be injected into the
// sandbox and no `driver` bridge channel is needed.  When SANDBOX_ORIGIN
// is flipped to a distinct origin this transport is swapped for a
// postMessage one (and `executeDriverOp` then runs inside the sandbox);
// the `RemotePage`/`DriverTransport` contract is unchanged.

import { DomPage } from "./dom-page.js";
import { executeDriverOp, type DriverOp, type DriverReply } from "./locator-chain.js";
import type { DriverTransport } from "./remote-page.js";

export function makeIframeTransport(
  iframe: HTMLIFrameElement,
  opts?: { timeout?: number },
): DriverTransport {
  return {
    async send(op: DriverOp): Promise<DriverReply> {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow as
        | (Window & { __LOOM_BASENAME__?: string })
        | null;
      if (!doc || !win) {
        return { ok: false, message: "preview iframe is not ready" };
      }
      const page = new DomPage(doc, {
        basename: win.__LOOM_BASENAME__ ?? "",
        timeout: opts?.timeout,
      });
      return executeDriverOp(doc, page, op, opts?.timeout);
    },
  };
}
