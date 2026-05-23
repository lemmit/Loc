// Best-effort DOM screenshot for UI test proofs.
//
// Captures a node (the preview iframe's document) to a JPEG data URL via
// html-to-image.  Same-origin: invoked from the parent against the
// iframe's live DOM — html-to-image resolves computed styles through the
// node's own `ownerDocument.defaultView`, so iframe-local CSS/fonts are
// honoured.
//
// Capture is ALWAYS best-effort: a cross-origin asset (e.g. a remote
// image) can taint the canvas and make rasterization throw.  We resolve
// `undefined` on any failure so a screenshot can never flip a test's
// pass/fail.

import { toJpeg } from "html-to-image";

export interface CaptureOpts {
  width?: number;
  height?: number;
}

export async function captureNode(
  node: HTMLElement,
  opts?: CaptureOpts,
): Promise<string | undefined> {
  try {
    return await toJpeg(node, {
      // Proof imagery, not pixel-perfect — keep data URLs small and avoid
      // the slow, CORS-prone web-font inlining step.
      pixelRatio: 1,
      quality: 0.8,
      skipFonts: true,
      width: opts?.width,
      height: opts?.height,
    });
  } catch {
    return undefined;
  }
}
