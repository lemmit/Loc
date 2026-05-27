// ---------------------------------------------------------------------------
// View-model preparer for the design-token theme.
//
// Resolves defaults for any tokens the DSL leaves blank, expands shade
// ramps for the brand + neutral colours, and returns a plain JSON
// ThemeVM that any pack can render against.  The shade-ramp helpers
// live here (not in a Handlebars helper) so packs that don't need
// shades — e.g. a "minimalist" pack reading a single base colour —
// aren't forced to compute them.
// ---------------------------------------------------------------------------

import type { ThemeIR } from "../../../../ir/types/loom-ir.js";
import type { ThemeVM } from "../view-models.js";

/** Default brand colour when the system declares no `theme.primary`.
 *  Indigo — readable as a primary on white, distinct enough from
 *  Mantine's stock blue that generated apps look intentionally
 *  themed rather than untouched defaults. */
const DEFAULT_PRIMARY_HEX = "#4f46e5";
/** Default neutral.  Subtle warm-grey ramp keeps surfaces (cards,
 *  table rows) from feeling laboratory-cold the way pure mantine
 *  greys do. */
const DEFAULT_NEUTRAL_HEX = "#64748b";
/** Default semantic colours — chosen to read coherently across
 *  light + dark schemes and against the indigo / slate baseline.
 *  The baseline keeps templates that always emit semantic slots
 *  from rendering blank. */
const DEFAULT_SECONDARY_HEX = "#6fd1ff";
const DEFAULT_ACCENT_HEX = "#ffb98a";
const DEFAULT_SUCCESS_HEX = "#22c55e";
const DEFAULT_WARNING_HEX = "#f59e0b";
const DEFAULT_ERROR_HEX = "#ef4444";
/** Default body / heading family.  System-ui chain falls back
 *  cleanly without bundling a webfont; Inter takes over when the
 *  page already has it loaded. */
const DEFAULT_FONT_FAMILY =
  '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const DEFAULT_FONT_FAMILY_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const DEFAULT_RADIUS = "md";
const DEFAULT_COLOR_SCHEME: "light" | "dark" | "auto" = "light";

export function prepareThemeVM(t: ThemeIR | undefined): ThemeVM {
  const primary = t?.primary ?? DEFAULT_PRIMARY_HEX;
  const neutral = t?.neutral ?? DEFAULT_NEUTRAL_HEX;
  const secondary = t?.secondary ?? DEFAULT_SECONDARY_HEX;
  const accent = t?.accent ?? DEFAULT_ACCENT_HEX;
  const success = t?.success ?? DEFAULT_SUCCESS_HEX;
  const warning = t?.warning ?? DEFAULT_WARNING_HEX;
  const error = t?.error ?? DEFAULT_ERROR_HEX;
  const radius = t?.radius ?? DEFAULT_RADIUS;
  const fontFamily = t?.fontFamily ?? DEFAULT_FONT_FAMILY;
  const fontFamilyMonospace = t?.fontFamilyMono ?? DEFAULT_FONT_FAMILY_MONO;
  const colorScheme = t?.colorScheme ?? DEFAULT_COLOR_SCHEME;
  return {
    brandShades: generateShades(primary),
    neutralShades: generateShades(neutral),
    secondaryShades: generateShades(secondary),
    accentShades: generateShades(accent),
    successShades: generateShades(success),
    warningShades: generateShades(warning),
    errorShades: generateShades(error),
    radius,
    fontFamily,
    fontFamilyMonospace,
    colorScheme,
  };
}

// ---------------------------------------------------------------------------
// Shade ramp — RGB <-> HSL <-> hex, lightness-stepped.
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

interface Hsl {
  h: number;
  s: number;
  l: number;
}
interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  let s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (s.length === 3) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (s.length === 8) s = s.slice(0, 6);
  const n = parseInt(s, 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
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
