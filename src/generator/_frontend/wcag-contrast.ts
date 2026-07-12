// ---------------------------------------------------------------------------
// WCAG 2.x relative-luminance + contrast-ratio math.
//
// Pure, dependency-free colour math shared by the a11y tooling
// (accessibility.md).  Today it backs the per-pack token-contrast gate
// (`test/generator/frontend/theme-contrast.test.ts`); it is the same
// primitive the proposal's Layer-2 `loom.a11y-pack-incomplete` contrast check
// will consume when that lands, so it lives in `src/` rather than the test.
//
// The formulae are the normative WCAG ones:
//   relative luminance L = 0.2126·R + 0.7152·G + 0.0722·B, each channel
//     linearised via the sRGB transfer function.
//   contrast ratio = (L_lighter + 0.05) / (L_darker + 0.05), in [1, 21].
// AA requires ≥ 4.5:1 for normal text and ≥ 3:1 for large text / UI components.
// ---------------------------------------------------------------------------

/** WCAG AA contrast floor for normal-size body text. */
export const AA_NORMAL = 4.5;
/** WCAG AA contrast floor for large text (≥ 18.66px bold / 24px) and for
 *  non-text UI components (borders, focus rings, icons). */
export const AA_LARGE = 3;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse a `#rgb` / `#rrggbb` / `#rrggbbaa` hex string to 0–255 channels.
 *  Alpha is dropped (contrast is defined over opaque colours). */
export function hexToRgb(hex: string): Rgb {
  let s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (s.length === 3) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (s.length === 8) s = s.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  const n = Number.parseInt(s, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** WCAG relative luminance of an sRGB colour, in [0, 1]. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, in [1, 21].  Symmetric. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The better contrast a colour achieves against either candidate foreground
 *  — the "is there a readable text colour for this surface?" question.  A
 *  filled UI surface (a primary button, a semantic badge) is accessible when
 *  SOME standard text colour (light or dark) clears the threshold on it; the
 *  pack picks that colour.  Returns the higher of the two ratios. */
export function bestForegroundRatio(surface: string, light: string, dark: string): number {
  return Math.max(contrastRatio(surface, light), contrastRatio(surface, dark));
}
