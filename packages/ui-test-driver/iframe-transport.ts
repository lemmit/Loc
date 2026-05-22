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
import {
  executeDriverOp,
  type DriverOp,
  type DriverReply,
  type NetState,
} from "./locator-chain.js";
import type { DriverTransport } from "./remote-page.js";

export interface IframeTransportOptions {
  timeout?: number;
  /** Resolve the router basename from the sandbox window, so `goto("/x")`
   *  pushes `<basename>/x`.  Omit when the app is not mounted under a
   *  basename. */
  getBasename?: (win: Window) => string;
  /** Resolve in-flight network state from the sandbox document, used by the
   *  `networkidle` wait.  Omit to skip network-quiescence waits. */
  getNetState?: (doc: Document) => NetState | undefined;
}

export function makeIframeTransport(
  iframe: HTMLIFrameElement,
  opts?: IframeTransportOptions,
): DriverTransport {
  return {
    currentUrl(): string {
      return iframe.contentWindow?.location.href ?? "";
    },
    async send(op: DriverOp): Promise<DriverReply> {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) {
        return { ok: false, message: "preview iframe is not ready" };
      }
      const page = new DomPage(doc, {
        basename: opts?.getBasename?.(win) ?? "",
        timeout: opts?.timeout,
      });
      return executeDriverOp(doc, page, op, {
        timeout: opts?.timeout,
        getNetState: opts?.getNetState,
      });
    },
  };
}
