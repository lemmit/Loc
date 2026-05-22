// Sandbox-side driver entry — bundled by scripts/build-sandbox-driver.mjs
// into public/sandbox/driver.js and loaded by the preview document as a
// module (<script type="module" src=".../driver.js">).  It attaches the
// package's serveDriverOps to the MessagePort the stub leaves on
// window.__LOOM_PORT__, resolving UI test ops against the sandbox's own
// document.
//
// This is where the host's __LOOM_* globals are named (the driver package
// itself stays application-agnostic): basename and in-flight network state
// are read here and passed in as accessors.

import { serveDriverOps } from "../../../packages/ui-test-driver/index.js";

interface SandboxWindow extends Window {
  __LOOM_PORT__?: MessagePort;
  __LOOM_BASENAME__?: string;
}

interface NetWindow {
  __LOOM_NET__?: { inflight: number; last: number };
}

const w = window as unknown as SandboxWindow;
const port = w.__LOOM_PORT__;
if (port) {
  serveDriverOps(port, document, {
    getBasename: (win) => (win as unknown as SandboxWindow).__LOOM_BASENAME__ ?? "",
    getNetState: (doc) => (doc.defaultView as unknown as NetWindow)?.__LOOM_NET__,
  });
}
