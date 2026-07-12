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

import type { ThemeIR } from "../../ir/types/loom-ir.js";
import { generateShades } from "../../util/color.js";
import type { ThemeVM } from "./view-models.js";

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
