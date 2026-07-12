// ---------------------------------------------------------------------------
// Framework-neutral colour maths — the single home for the pure colour
// helpers shared across pipeline layers.
//
// Two consumer groups, at different layers, so this lives in `src/util/`
// (the shared floor both may import) rather than under `generator/`:
//   1. `generator/_frontend/theme-preparer.ts` expands the brand/neutral/
//      semantic ramps a pack renders (`generateShades`).
//   2. `language/validators/a11y.ts` checks a user's `theme {}` colours clear
//      WCAG-AA contrast at compile time (`loom.a11y-theme-contrast`), and the
//      per-pack token-contrast gate asserts the same over the default palette.
//
// The WCAG formulae are the normative ones:
//   relative luminance L = 0.2126·R + 0.7152·G + 0.0722·B, each channel
//     linearised via the sRGB transfer function.
//   contrast ratio = (L_lighter + 0.05) / (L_darker + 0.05), in [1, 21].
// AA requires ≥ 4.5:1 for normal text and ≥ 3:1 for large text / UI.
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

interface Hsl {
  h: number;
  s: number;
  l: number;
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

/** True when `hex` is a syntactically valid `#rgb`/`#rrggbb`/`#rrggbbaa`
 *  colour — a cheap guard so callers can skip non-hex theme values (a CSS
 *  colour name, a `var(--x)`) rather than throw. */
export function isHexColor(hex: string): boolean {
  const s = hex.startsWith("#") ? hex.slice(1) : hex;
  return /^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s);
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

// ---------------------------------------------------------------------------
// Shade ramp — RGB <-> HSL <-> hex, lightness-stepped.  A pack renders a
// 10-shade ramp from each brand/neutral/semantic base colour; index 6 is the
// base itself (light-scheme fill), index 5 the dark-scheme fill.
// ---------------------------------------------------------------------------

export function generateShades(hex: string): string[] {
  const { h, s, l } = hexToHsl(hex);
  const shadeL = (i: number): number => {
    if (i === 6) return l;
    if (i < 6) {
      const t = i / 6;
      return clamp(96 - (96 - l) * t, 4, 96);
    }
    const t = (i - 6) / 3;
    return clamp(l - (l - 10) * t, 4, 96);
  };
  const shadeS = (i: number): number => {
    if (i === 6) return s;
    const desat = i < 3 || i > 8 ? 0.85 : 1;
    return clamp(s * desat, 0, 100);
  };
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(hslToHex({ h, s: shadeS(i), l: shadeL(i) }));
  }
  return out;
}

function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb(hsl: Hsl): Rgb {
  const h = hsl.h / 360;
  const s = hsl.s / 100;
  const l = hsl.l / 100;
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function rgbToHex(rgb: Rgb): string {
  const h = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

function hexToHsl(hex: string): Hsl {
  return rgbToHsl(hexToRgb(hex));
}

function hslToHex(hsl: Hsl): string {
  return rgbToHex(hslToRgb(hsl));
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
