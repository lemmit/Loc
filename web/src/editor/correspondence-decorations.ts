// The CSS half of the source ↔ output correspondence (M-T8.20 slice 3).
//
// Monaco decorations are applied by CLASS NAME, not by inline style, so a
// per-construct colour needs a class per colour.  `constructHue` maps every
// construct onto one of eight fixed hues (`correspondence.ts`), which is what
// makes a finite stylesheet possible at all: eight band classes for the
// colour-map overlay, eight stronger "hit" classes for the file(s) the hovered
// declaration actually produced, and one flash for the reverse direction.
//
// Injected once, lazily, into `document.head`.  Both Monaco instances — the
// editable source editor and the read-only generated-file viewer — share it,
// which is the point: the same construct is the same colour on both sides.

import { BAND_HUE_COUNT, hueOfBand } from "../build/correspondence";

const STYLE_ID = "loom-correspondence-styles";

/** One tinted range in the SOURCE editor.  Declared here, not in
 *  `LoomEditor.tsx`, so a consumer that only needs the prop TYPE
 *  (`layout/EditorPane.tsx`) never names the module carrying the 9.56 MB
 *  static `monaco-editor` import — the M-T8.15 boundary. */
export interface SourceHighlight {
  startLine: number;
  endLine: number;
  /** Band index from `constructBand`, or `undefined` for the
   *  hue-independent flash. */
  band?: number;
  kind: "band" | "flash";
}

/** One tinted range in the generated-file viewer.  Here for the same reason
 *  as `SourceHighlight`: `layout/DesktopShell.tsx` builds these and must not
 *  name `preview/FileViewer.tsx`, which carries the static monaco import.
 *  `hit` is what the declaration under the editor's cursor produced; `band`
 *  is the standing colour-map overlay. */
export interface ViewerHighlight {
  startLine: number;
  endLine: number;
  /** Band index from `constructBand`. */
  band: number;
  kind: "band" | "hit";
}

/** Class for the subtle colour-map band of band index `i`. */
export function bandClass(index: number): string {
  return `loom-band-${index % BAND_HUE_COUNT}`;
}

/** Class for the stronger "this is what the cursor produced" highlight. */
export function hitClass(index: number): string {
  return `loom-hit-${index % BAND_HUE_COUNT}`;
}

/** Class for the reverse direction's transient `.ddd` flash. */
export const FLASH_CLASS = "loom-corr-flash";

/** Install the stylesheet if it is not already there.  Idempotent and
 *  safe to call on every editor mount. */
export function installCorrespondenceStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const rules: string[] = [];
  for (let i = 0; i < BAND_HUE_COUNT; i++) {
    const hue = hueOfBand(i);
    rules.push(`.${bandClass(i)} { background: hsla(${hue}, 70%, 55%, 0.13); }`);
    rules.push(
      `.${hitClass(i)} { background: hsla(${hue}, 75%, 55%, 0.30); ` +
        `box-shadow: inset 2px 0 0 hsla(${hue}, 80%, 65%, 0.9); }`,
    );
  }
  // The flash is deliberately hue-independent: it answers "where did THIS
  // generated line come from", and a single, unmistakable colour reads faster
  // than one more member of the band palette.
  rules.push(
    `.${FLASH_CLASS} { background: hsla(48, 90%, 60%, 0.26); ` +
      "box-shadow: inset 2px 0 0 hsla(48, 95%, 70%, 0.95); }",
  );
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}
