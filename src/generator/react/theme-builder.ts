import type { ThemeIR } from "../../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// Theme emission for the Mantine target.
//
// Translates the framework-agnostic ThemeIR (system-level
// `theme { ... }` block) into a Mantine `createTheme(...)` config in
// `src/theme.ts`.  Generates a 10-shade ramp for each named hex
// color so Mantine's `colors[<name>]` arrays are populated without
// any runtime dependency.
//
// Future: a sibling `theme-shadcn.ts` consumes the same ThemeIR and
// emits CSS variables for shadcn/ui.  Both targets read identical
// source declarations — that's the whole point of routing through
// ThemeIR rather than exposing Mantine knobs at the DSL surface.
// ---------------------------------------------------------------------------

/** Default brand colour when the system declares no `theme.primary`.
 *  Indigo — readable as a primary on white, distinct enough from
 *  Mantine's stock blue that generated apps look intentionally
 *  themed rather than untouched defaults. */
const DEFAULT_PRIMARY_HEX = "#4f46e5";
/** Default neutral.  Subtle warm-grey ramp keeps surfaces (cards,
 *  table rows) from feeling laboratory-cold the way pure mantine
 *  greys do. */
const DEFAULT_NEUTRAL_HEX = "#64748b";
/** Default body / heading family.  System-ui chain falls back
 *  cleanly without bundling a webfont; Inter takes over when the
 *  page already has it loaded. */
const DEFAULT_FONT_FAMILY =
  '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const DEFAULT_RADIUS = "md";

/** Generate `src/theme.ts` containing the Mantine `createTheme`
 *  config.  Always produces a usable theme — when the IR carries no
 *  tokens, falls back to the polished defaults defined above so
 *  every generated app boots with a coherent look. */
export function buildMantineTheme(t: ThemeIR): string {
  const primary = t.primary ?? DEFAULT_PRIMARY_HEX;
  const neutral = t.neutral ?? DEFAULT_NEUTRAL_HEX;
  const radius = t.radius ?? DEFAULT_RADIUS;
  const fontFamily = t.fontFamily ?? DEFAULT_FONT_FAMILY;

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(
    `import { createTheme, type MantineColorsTuple } from "@mantine/core";`,
  );
  lines.push("");

  // Per-color shade tuple.  The user's hex anchors at index 6 (the
  // shade Mantine uses for primary buttons / call-to-action surfaces)
  // and the rest are interpolated against white (lighter half) and
  // black (darker half) using HSL lightness.  This is the same
  // approach mantinehub-style theme generators use; it produces
  // visually-coherent palettes for any reasonable input hex.
  lines.push(`const brand: MantineColorsTuple = [`);
  for (const shade of generateShades(primary)) lines.push(`  "${shade}",`);
  lines.push(`];`);
  lines.push("");
  lines.push(`const neutral: MantineColorsTuple = [`);
  for (const shade of generateShades(neutral)) lines.push(`  "${shade}",`);
  lines.push(`];`);
  lines.push("");

  lines.push(`export const theme = createTheme({`);
  lines.push(`  primaryColor: "brand",`);
  lines.push(`  primaryShade: { light: 6, dark: 5 },`);
  lines.push(`  colors: { brand, gray: neutral },`);
  lines.push(`  defaultRadius: ${JSON.stringify(radius)},`);
  lines.push(`  fontFamily: ${JSON.stringify(fontFamily)},`);
  lines.push(`  fontFamilyMonospace: ${JSON.stringify('ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace')},`);
  lines.push(`  headings: {`);
  lines.push(`    fontFamily: ${JSON.stringify(fontFamily)},`);
  lines.push(`    fontWeight: "600",`);
  lines.push(`    sizes: {`);
  lines.push(`      h1: { fontSize: "2rem", lineHeight: "1.25" },`);
  lines.push(`      h2: { fontSize: "1.5rem", lineHeight: "1.3" },`);
  lines.push(`      h3: { fontSize: "1.25rem", lineHeight: "1.35" },`);
  lines.push(`      h4: { fontSize: "1rem", lineHeight: "1.4" },`);
  lines.push(`    },`);
  lines.push(`  },`);
  // Tighten Mantine component defaults so generated cards / inputs
  // / buttons feel like a polished product instead of a wireframe.
  lines.push(`  components: {`);
  lines.push(`    Card: { defaultProps: { shadow: "xs", radius: "md", padding: "lg", withBorder: true } },`);
  lines.push(`    Paper: { defaultProps: { shadow: "xs", radius: "md", withBorder: true } },`);
  lines.push(`    Button: { defaultProps: { radius: "md" } },`);
  lines.push(`    TextInput: { defaultProps: { radius: "md" } },`);
  lines.push(`    NumberInput: { defaultProps: { radius: "md" } },`);
  lines.push(`    Select: { defaultProps: { radius: "md" } },`);
  lines.push(`    Switch: { defaultProps: { radius: "md" } },`);
  lines.push(`    Table: { defaultProps: { verticalSpacing: "sm", horizontalSpacing: "md" } },`);
  lines.push(`    Badge: { defaultProps: { radius: "sm" } },`);
  lines.push(`  },`);
  lines.push(`});`);

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Shade ramp — RGB <-> HSL <-> hex, lightness-stepped.
//
// The ramp anchors the user's color at index 6 (Mantine's "primary"
// shade for filled buttons + links).  Indices 0-5 lighten toward
// near-white; 7-9 darken toward near-black.  Output is 10 hex
// strings ready to drop into a `MantineColorsTuple`.
//
// Pure function; no DOM / browser dependencies.  Runs at generation
// time, the resulting hex strings are baked into theme.ts.
// ---------------------------------------------------------------------------

export function generateShades(hex: string): string[] {
  const { h, s, l } = hexToHsl(hex);
  // Target lightness per shade (0 = lightest, 9 = darkest).  Anchor
  // index 6 to the user's input lightness; interpolate a smooth
  // curve outward in both directions, clipped to [4, 96] so we
  // never produce pure white or pure black.
  const shadeL = (i: number): number => {
    if (i === 6) return l;
    if (i < 6) {
      // Lighter half: 0 = ~96, ascending toward l at 6.
      const t = i / 6; // 0..1
      return clamp(96 - (96 - l) * t, 4, 96);
    }
    // Darker half: 7..9 → step toward ~10.
    const t = (i - 6) / 3; // 0..1
    return clamp(l - (l - 10) * t, 4, 96);
  };
  // Saturation stays close to the input; very light + very dark
  // shades drop saturation slightly so they don't look gaudy.
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
  if (s.length === 8) s = s.slice(0, 6); // strip alpha
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
