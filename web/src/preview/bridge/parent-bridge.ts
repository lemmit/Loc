// Parent ↔ preview-sandbox bridge.
//
// Replaces the Service-Worker transport (`public/preview-sw.js` +
// `sw-host.ts`).  The preview iframe loads a static stub from
// `SANDBOX_ORIGIN`; this class hands that stub the synthesised
// document plus ONE `MessagePort`, then answers the runtime requests
// the stub's `fetch` shim forwards over that port.
//
// Capability, not origin: the port is the channel.  We still pin
// `postMessage` to `SANDBOX_ORIGIN` and filter by `event.source`, so
// the handshake is correct same-origin (now) and cross-origin (after
// the origin flip) alike.
//
// Lifecycle is deterministic — no SW revival.  The bridge lives as
// long as the iframe element; a new bundle remounts the iframe, which
// re-runs the stub → ready → init handshake.

import type {
  DispatchResult,
  SerializedRequest,
} from "../../runtime/protocol.js";

/** Runtime request the stub forwards (one per intercepted `fetch`). */
interface RuntimeForward {
  kind: "runtime";
  rid: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Reply posted back over the port for a `RuntimeForward`. */
type RuntimeReply =
  | {
      rid: number;
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    }
  | { rid: number; ok: false; message: string };

export class SandboxBridge {
  private port: MessagePort | null = null;
  private readyListener: ((e: MessageEvent) => void) | null = null;
  private disposed = false;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly targetOrigin: string,
    private readonly dispatch: (
      req: SerializedRequest,
    ) => Promise<DispatchResult>,
  ) {}

  /** Begin the handshake: listen for the stub's `loom-stub-ready`,
   *  then post the document + a transferred port.  Idempotent per
   *  bridge instance — the listener detaches after the first init. */
  start(html: string): void {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== this.iframe.contentWindow) return;
      const data = e.data as { type?: string } | undefined;
      if (data?.type !== "loom-stub-ready") return;
      window.removeEventListener("message", onMessage);
      this.readyListener = null;
      if (this.disposed) return;
      this.connect(html);
    };
    this.readyListener = onMessage;
    window.addEventListener("message", onMessage);
  }

  private connect(html: string): void {
    const win = this.iframe.contentWindow;
    if (!win) return;
    const channel = new MessageChannel();
    this.port = channel.port1;
    channel.port1.onmessage = (ev): void => {
      void this.onRuntimeForward(ev);
    };
    win.postMessage({ type: "loom-init", html }, this.targetOrigin, [
      channel.port2,
    ]);
  }

  private async onRuntimeForward(ev: MessageEvent): Promise<void> {
    const m = ev.data as RuntimeForward | undefined;
    if (!m || m.kind !== "runtime" || typeof m.rid !== "number") return;
    let reply: RuntimeReply;
    try {
      const result = await this.dispatch({
        url: m.url,
        method: m.method,
        headers: m.headers,
        body: m.body,
      });
      reply = result.ok
        ? {
            rid: m.rid,
            ok: true,
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
            body: result.response.body,
          }
        : { rid: m.rid, ok: false, message: result.message };
    } catch (err) {
      reply = {
        rid: m.rid,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    this.port?.postMessage(reply);
  }

  dispose(): void {
    this.disposed = true;
    if (this.readyListener) {
      window.removeEventListener("message", this.readyListener);
      this.readyListener = null;
    }
    this.port?.close();
    this.port = null;
  }
}
