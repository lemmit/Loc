// Service Worker host — registration + bundle push for the preview.
//
// Status: SCAFFOLDING.  The playground's UI doesn't yet route any
// preview content through the SW — Preview.tsx still uses the
// srcdoc + URL-patch path documented in iframe-html.ts.  This
// module exists so the next migration PR has a stable seam to
// build against:
//
//   const reg = await registerPreviewSw();
//   if (reg) await pushBundle(reg, { html, js, css });
//   <iframe src={sandboxUrl()}></iframe>
//
// Today, only `registerPreviewSw()` is wired up — App.tsx calls it
// once on mount so production deploys ship a registered (but unused)
// SW.  This shakes out path / scope issues across local dev,
// `vite preview`, and GH Pages before the migration depends on it
// working.

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

/** Sandbox URL the iframe will load from once the migration lands.
 *  Resolved against the page so it includes the deploy base. */
export function sandboxUrl(): string {
  return new URL(SANDBOX_PREFIX, location.href).toString();
}
