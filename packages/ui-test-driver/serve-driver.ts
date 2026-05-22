// Sandbox-side driver executor.  Listens on a MessagePort for
// `kind: "driver"` requests, runs each DriverOp against the sandbox's own
// document via executeDriverOp, and posts the reply back (tagged with the
// originating `rid` and the current URL).
//
// This is the cross-origin counterpart to the same-origin iframe
// transport: there the parent reaches the iframe document directly; here
// the executor lives inside the sandbox and the parent talks to it over
// the port.  The host wires this up (e.g. the preview stub), passing
// accessors for basename / in-flight network state so this package names
// no host global.

import { DomPage } from "./dom-page.js";
import { executeDriverOp, type DriverOp, type NetState } from "./locator-chain.js";

export interface ServeDriverOptions {
  /** Resolve in-flight network state for `waitForLoadState("networkidle")`. */
  getNetState?: (doc: Document) => NetState | undefined;
  /** Resolve the router basename so `goto("/x")` pushes `<basename>/x`. */
  getBasename?: (win: Window) => string;
  timeout?: number;
}

/** Attach a driver executor to `port`, resolving ops against `doc`.
 *  Returns a disposer that detaches the listener. */
export function serveDriverOps(
  port: MessagePort,
  doc: Document,
  opts?: ServeDriverOptions,
): () => void {
  const handler = (ev: MessageEvent): void => {
    const m = ev.data as
      | { rid?: number; kind?: string; op?: DriverOp }
      | undefined;
    if (!m || m.kind !== "driver" || typeof m.rid !== "number" || !m.op) return;
    const rid = m.rid;
    const win = doc.defaultView;
    const page = new DomPage(doc, {
      basename: win && opts?.getBasename ? opts.getBasename(win) : "",
      timeout: opts?.timeout,
    });
    void executeDriverOp(doc, page, m.op, {
      timeout: opts?.timeout,
      getNetState: opts?.getNetState,
    }).then((reply) => {
      port.postMessage({ rid, ...reply, url: win?.location.href });
    });
  };
  port.addEventListener("message", handler);
  port.start?.();
  return () => port.removeEventListener("message", handler);
}
