// ---------------------------------------------------------------------------
// PreviewHost — the seam around the live-preview surface.
//
// Today: registerPreviewSw + pushBundle + attachRuntimePort + the
// iframe lifecycle in Preview.tsx + public/preview-sw.js.  P2 wraps
// exactly that as the default `SwIframePreviewHost`, behaviour
// identical.
//
// The contract exists mostly to make ONE rule structural rather than
// convention: a global mode toggle (editor / split / preview) MUST
// NOT unmount the iframe — doing so tears down the SW bridge and
// loses in-iframe focus/scroll.  Visibility is a CSS concern; the
// host owns a single long-lived iframe and only ever hides/shows it.
// ---------------------------------------------------------------------------

import type { PreviewMaterial } from "./runtime-engine.js";
import type { SerializedRequest, DispatchResult } from "../runtime/protocol.js";

/** HTML document + assets to serve for the sandbox origin.  `html`
 *  is synthesised by the host (importmap, Tailwind shim, globals);
 *  `js`/`css` come from `PrepareResult.preview`. */
export interface PreviewBundle {
  html: string;
  js: string;
  css?: string;
}

export interface PreviewHost {
  /** Attach the (single, persistent) preview iframe under `container`.
   *  Idempotent — calling again with the same container is a no-op. */
  mount(container: HTMLElement): void;

  /** Push the latest bundle so sandbox navigations serve it.
   *  Resolves once the SW has acked (or a safety timeout fires). */
  setBundle(bundle: PreviewBundle): Promise<void>;

  /** Wire the runtime bridge: `<sandbox>/runtime/*` fetches from the
   *  iframe are forwarded to `dispatch`.  Returns a detach disposer. */
  attachRuntime(
    dispatch: (req: SerializedRequest) => Promise<DispatchResult>,
  ): Promise<(() => void) | null>;

  /** Re-navigate the iframe to the sandbox root (after a fresh
   *  `setBundle`).  Never unmounts. */
  reload(): void;

  /** Show/hide WITHOUT unmounting — used by the global mode switch. */
  setVisible(visible: boolean): void;

  dispose(): void;
}

/** Build the sandbox HTML document from preview material.  Declared
 *  here as the seam; P2 moves the existing `iframe-html.ts` synth
 *  behind it unchanged. */
export type PreviewHtmlSynth = (material: PreviewMaterial) => string;
