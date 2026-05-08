// Service Worker host — registration, bundle push, and runtime
// port attach for the preview.
//
//   - `registerPreviewSw()` is called once on App mount.
//   - `pushBundle(reg, bundle)` ships the latest bundled HTML to
//     the SW so navigations to the sandbox URL get served the
//     right document.
//   - `attachRuntimePort(reg, dispatch)` wires the SW's runtime
//     fetch bridge to the in-process `LoomRuntimeClient`.  The
//     SW forwards `<sandbox>/runtime/*` fetches over the port;
//     `dispatch` calls runtime.dispatch() and posts back the
//     response.

const SW_FILE = "preview-sw.js";
export const SANDBOX_PREFIX = "__loom_sandbox__/";

/** Service Worker registration entry point.  Resolves to the
 *  registration on success, `null` when SW isn't available
 *  (insecure context, missing API, or registration error).  Never
 *  throws — preview should keep working via the legacy srcdoc path
 *  when SW registration fails.
 *
 *  Path: relative to the page's URL, so it works under both `/`
 *  (vite dev) and `/loc/playground/` (GH Pages) without hard-coding
 *  the deploy base. */
export async function registerPreviewSw(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  // Only register over secure contexts.  `localhost` counts; GH
  // Pages serves over HTTPS; `file://` and plain HTTP do not.
  if (!self.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register(SW_FILE, {
      // Default scope == SW directory.  Explicit for clarity, and
      // because some browsers warn when the option is omitted in
      // module-script SW contexts.
      scope: "./",
    });
  } catch (err) {
    // Swallow — SW is purely additive at this stage.  Log so dev-
    // tools surface registration failures without breaking the
    // playground.
    // eslint-disable-next-line no-console
    console.warn("[loom] preview SW registration failed", err);
    return null;
  }
}

/** Bundle payload pushed to the SW.  Future migration PRs will
 *  flesh this out (per-asset MIME types, embedded importmap, etc.);
 *  the current shape is the minimum the SW's placeholder handler
 *  knows to look at. */
export interface PreviewBundle {
  html: string;
  js: string;
  css?: string;
}

/** Send the latest bundle to the SW so its sandbox routes can
 *  serve it.  Resolves once the SW has stored the bundle and
 *  acked back through the MessageChannel — callers that navigate
 *  the iframe should await this so the next sandbox fetch hits
 *  the new bundle, not the previous one.  Safety-netted at 1 s
 *  so a misbehaving SW can't deadlock the preview. */
export function pushBundle(
  reg: ServiceWorkerRegistration,
  bundle: PreviewBundle,
): Promise<void> {
  const ctrl = reg.active ?? reg.waiting ?? reg.installing;
  if (!ctrl) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      ch.port1.close();
      resolve();
    };
    ch.port1.onmessage = finish;
    ctrl.postMessage({ type: "loom-sw/set-bundle", bundle }, [ch.port2]);
    setTimeout(finish, 1_000);
  });
}

/** Sandbox URL the preview iframe loads from.  Resolved against
 *  the page so it includes the deploy base. */
export function sandboxUrl(): string {
  return new URL(SANDBOX_PREFIX, location.href).toString();
}

/** Forwarded request the SW posts when the preview iframe fetches
 *  `<sandbox>/runtime/*`.  `dispatch` returns the eventual
 *  response which the SW turns back into a `Response` for the
 *  in-iframe `fetch()` caller. */
export interface RuntimeRequest {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type RuntimeReply =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    }
  | { ok: false; message: string };

/** Wire the SW's runtime bridge to a dispatcher.  Resolves to a
 *  disposer that detaches the port (closing it on the parent
 *  side; the SW will see subsequent runtime requests fail with
 *  502 until a new port attaches).
 *
 *  Returns `null` if the SW has no `active`/`waiting`/`installing`
 *  worker — caller should retry after `serviceWorker.ready`.
 *
 *  Awaits the SW's `attached` ack so callers can sequence the
 *  iframe render after the port is in place; otherwise the
 *  bundle's first fetch could outrun the attach and 502. */
export async function attachRuntimePort(
  reg: ServiceWorkerRegistration,
  dispatch: (req: RuntimeRequest) => Promise<RuntimeReply>,
): Promise<(() => void) | null> {
  const ctrl = reg.active ?? reg.waiting ?? reg.installing;
  if (!ctrl) return null;
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev): void => {
    const data = ev.data as RuntimeRequest | { type: "attached" } | undefined;
    if (!data) return;
    if ("type" in data) return; // ack — handled below
    void (async () => {
      try {
        const reply = await dispatch(data);
        ch.port1.postMessage({ id: data.id, ...reply });
      } catch (err) {
        ch.port1.postMessage({
          id: data.id,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };
  await new Promise<void>((resolve) => {
    const safety = setTimeout(resolve, 1_000);
    const prev = ch.port1.onmessage;
    ch.port1.onmessage = (ev): void => {
      const data = ev.data as { type?: string } | undefined;
      if (data && data.type === "attached") {
        clearTimeout(safety);
        ch.port1.onmessage = prev;
        resolve();
        return;
      }
      // Forward any non-ack messages that arrive in this window
      // (unlikely but safe) to the regular handler.
      if (prev) prev.call(ch.port1, ev);
    };
    ctrl.postMessage({ type: "loom-sw/attach-runtime" }, [ch.port2]);
  });
  return () => ch.port1.close();
}
