// ---------------------------------------------------------------------------
// SwIframePreviewHost — the default PreviewHost.
//
// Consolidates the Service-Worker ↔ iframe bridge that used to be
// imported piecemeal by Preview.tsx (registerPreviewSw / pushBundle /
// attachRuntimePort / sandboxUrl + the inline html synth, basename
// calc, and DispatchResult→RuntimeReply adapter).
//
// P2 is a strict, behaviour-preserving pass-through: every method
// does exactly what the equivalent inline code in Preview.tsx did,
// in the same order.  The value is the seam — the SW machinery now
// lives behind one object, so a future engine's preview (nodepod's
// own SW preview, or the npm-in-browser engine reusing this one)
// swaps here without touching the React component.
//
// DOM/visibility ownership stays in Preview.tsx for now (React owns
// the iframe element + fullscreen).  `reload`/`setVisible` operate on
// an iframe the component registers via `bindIframe`; the
// never-unmount contract becomes structurally enforced when the
// global mode switcher lands (later phase) and this host takes full
// ownership of the element.
// ---------------------------------------------------------------------------

import { makePreviewHtml } from "./iframe-html.js";
import { attachRuntimePort, pushBundle, sandboxUrl } from "./sw-host.js";
import type { RuntimeDispatcher } from "../engine/runtime-engine.js";
import type { PreviewBundle, PreviewHost } from "../engine/preview-host.js";
import type { PreviewMaterial } from "../engine/runtime-engine.js";

export class SwIframePreviewHost implements PreviewHost {
  private container: HTMLElement | null = null;
  private iframe: HTMLIFrameElement | null = null;

  /** Component hook — Preview.tsx still renders the iframe element
   *  (React-owned) and registers it here so `reload`/`setVisible`
   *  can act on it.  Transitional until the mode switcher moves
   *  element ownership into the host. */
  bindIframe(el: HTMLIFrameElement | null): void {
    this.iframe = el;
  }

  mount(container: HTMLElement): void {
    this.container = container;
  }

  /** Synthesise the sandbox document exactly as Preview.tsx did:
   *  basename = the sandbox URL pathname (BrowserRouter base), then
   *  the same makePreviewHtml call. */
  synthHtml(material: PreviewMaterial): { html: string; bundle: PreviewBundle } {
    const sandboxBase = new URL(sandboxUrl()).pathname.replace(/\/$/, "");
    const html = makePreviewHtml({
      js: material.js,
      css: material.css,
      versions: material.versions,
      sandboxBase,
    });
    return { html, bundle: { html, js: material.js, css: material.css } };
  }

  async setBundle(bundle: PreviewBundle): Promise<void> {
    const reg = await navigator.serviceWorker.ready;
    await pushBundle(reg, bundle);
  }

  /** Wire the SW runtime bridge to a RuntimeDispatcher.  The
   *  DispatchResult→RuntimeReply adaptation is the same shape the
   *  inline closure in Preview.tsx used. */
  async attachRuntime(
    dispatch: RuntimeDispatcher["dispatch"],
  ): Promise<(() => void) | null> {
    const reg = await navigator.serviceWorker.ready;
    return attachRuntimePort(reg, async (req) => {
      const result = await dispatch({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      if (result.ok) {
        return {
          ok: true,
          status: result.response.status,
          statusText: result.response.statusText,
          headers: result.response.headers,
          body: result.response.body,
        };
      }
      return { ok: false, message: result.message };
    });
  }

  /** Sandbox URL the iframe loads from. */
  url(): string {
    return sandboxUrl();
  }

  reload(): void {
    if (this.iframe) this.iframe.src = sandboxUrl();
  }

  setVisible(visible: boolean): void {
    if (this.iframe) this.iframe.style.display = visible ? "" : "none";
  }

  dispose(): void {
    this.container = null;
    this.iframe = null;
  }
}
