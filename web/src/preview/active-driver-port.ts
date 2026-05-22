// Bridge between the Preview component (which owns the SandboxBridge and
// its MessagePort) and the Tests panel (which builds the UI-test
// transport).  The two are sibling components with no shared React state
// for this, and the Tests panel already reaches for the live preview
// imperatively — so a tiny module singleton is the simplest seam: Preview
// publishes the active port on handshake and clears it on dispose; the
// Tests panel reads it when the user runs a suite.

let activePort: MessagePort | null = null;

export function setActiveDriverPort(port: MessagePort | null): void {
  activePort = port;
}

export function getActiveDriverPort(): MessagePort | null {
  return activePort;
}
