// Accessibility validators (accessibility.md Phase 3) — the compile-time
// enforcement of the few a11y facts Loom genuinely cannot derive.  The
// per-primitive contract lives in the generator's walker registry
// (src/generator/_walker/a11y.ts, `A11yObligation`); these checks are the
// language-side twin that fail-fast on the underivable, so an image without a
// text alternative is a build error, never a control shipped silently to a
// screen reader.
//
// The layering rule forbids `language/` importing `generator/`, so the small
// set of primitives with an underivable-fact obligation is named here directly
// (the same hand-listed-and-test-pinned pattern as walker-stdlib.ts).

import { AstUtils, type ValidationAcceptor } from "langium";
import { AA_NORMAL, bestForegroundRatio, generateShades, isHexColor } from "../../util/color.js";
import type { BuilderCall, Model, ThemeBlock } from "../generated/ast.js";

/** A `BuilderEntry` with no `name:` is a bare positional value. */
function hasPositional(bc: BuilderCall): boolean {
  return bc.entries.some((e) => e.name === undefined || e.name === null);
}

function hasEntry(bc: BuilderCall, name: string): boolean {
  return bc.entries.some((e) => e.name === name);
}

/** `Image` / `Avatar` that actually render an image (they carry a `src`)
 *  must supply a human text alternative — `alt: "…"` — or be explicitly
 *  marked `decorative: true` (→ `alt=""`).  Alt text is human content, not
 *  structure, so Loom cannot derive it; a missing alt is a WCAG 1.1.1
 *  failure (`loom.a11y-missing-alt`).  An `Avatar` with no `src` renders a
 *  non-image fallback (initials / user glyph) and needs no alt. */
export function checkImageAltText(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    if (bc.type !== "Image" && bc.type !== "Avatar") continue;

    // `alt:` (a real description) or `decorative: true` (a deliberate
    // `alt=""`) both satisfy the obligation.
    if (hasEntry(bc, "alt") || hasEntry(bc, "decorative")) continue;

    // Only an image-bearing element needs alt.  `Image` takes its `src`
    // from `src:` or the first positional (`Image { "/logo.png" }`);
    // `Avatar` only from `src:` (a positional is fallback initials).
    const showsImage = hasEntry(bc, "src") || (bc.type === "Image" && hasPositional(bc));
    if (!showsImage) continue;

    accept(
      "error",
      `'${bc.type}' renders an image but has no text alternative. Add 'alt: "…"' describing it, or 'decorative: true' if it conveys nothing (renders alt=""). Alt text is human content Loom can't derive — a missing alt fails WCAG 1.1.1.`,
      { node: bc, property: "type", code: "loom.a11y-missing-alt" },
    );
  }
}

/** A command `Button` whose only content is an `icon:` (no visible text, no
 *  explicit `label:`) renders a bare glyph — a screen reader announces the
 *  meaningless default "Button" text.  The button's a11y contract needs a name
 *  (`{ role: "button", needsName: true }`); the name here is human content Loom
 *  can't derive, so warn (`loom.a11y-icon-only-no-name`, WCAG 4.1.2 Name, Role,
 *  Value).  Visible text (`Button { "Delete", icon: "trash" }`) or an explicit
 *  `label: "Delete"` (emitted as `aria-label`) both satisfy it. */
export function checkIconOnlyButtonName(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    if (bc.type !== "Button") continue;

    const hasIcon = hasEntry(bc, "icon") || hasEntry(bc, "iconSvg");
    if (!hasIcon) continue;
    // Visible positional text, or an explicit accessible name, satisfies it.
    if (hasPositional(bc)) continue;
    if (hasEntry(bc, "label")) continue;

    accept(
      "warning",
      `Icon-only 'Button' has no accessible name — a screen reader announces the meaningless default "Button". Add visible text ('Button { "Delete", icon: "trash" }') or an accessible name ('label: "Delete"', emitted as aria-label). A control without a name fails WCAG 4.1.2.`,
      { node: bc, property: "type", code: "loom.a11y-icon-only-no-name" },
    );
  }
}

// The `theme {}` colour roles that a pack renders as FILLED surfaces (buttons,
// badges, alerts) or coloured text.  Each becomes a 10-shade ramp; the fill is
// shade 6 (light scheme) / 5 (dark scheme) — the same indices the per-pack
// token-contrast gate and the emitter use.  The non-colour props (radius,
// fontFamily, colorScheme) are skipped.
const THEME_COLOR_ROLES = new Set([
  "primary",
  "neutral",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
]);

// The two standard text colours a pack pairs with a coloured surface — a
// surface is usable when one of them clears AA on it (the pack picks).  Same
// pair the token-contrast gate uses.
const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#0f172a";
// The light-scheme fill is shade 6 — and shade 6 IS the user's chosen colour
// (the ramp keeps the base lightness there).  We check only this shade: it is
// the colour the author literally picked and the surface a light-scheme pack
// actually fills with.  The derived lighter/darker shades are Loom's ramp, not
// the author's choice, so warning on them would be surprising (and shade 5 only
// matters in dark mode) — the per-pack token-contrast gate covers the full ramp.
const FILL_INDEX = 6;

/** A user-supplied `theme {}` colour whose fill shades leave NO readable
 *  standard text colour (neither white nor near-black clears WCAG-AA) can't
 *  produce a conformant app no matter how correct the markup — the
 *  zero-effort-AA-default guarantee (accessibility.md) is only as good as the
 *  tokens.  Warn (not error): the pack picks the text colour and a borderline
 *  brand shouldn't hard-block a build, but an unreadable one is surfaced at
 *  compile time rather than waiting for the nightly axe gate.
 *
 *  Scope is token-level (accessibility.md Open Question #2): "does a readable
 *  text colour exist for this fill?", not every component-state pairing.
 *  Non-hex values (a CSS colour name, `var(--x)`) are skipped — contrast isn't
 *  computable without resolving them. */
export function checkThemeContrast(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "ThemeBlock") continue;
    for (const prop of (node as ThemeBlock).props) {
      if (!THEME_COLOR_ROLES.has(prop.name)) continue;
      // STRING strips its delimiters, so `value` is the bare `#3b82f6`.
      const hex = prop.value;
      if (!isHexColor(hex)) continue;
      const fill = generateShades(hex)[FILL_INDEX]!;
      const ratio = bestForegroundRatio(fill, LIGHT_TEXT, DARK_TEXT);
      if (ratio < AA_NORMAL) {
        accept(
          "warning",
          `theme '${prop.name}' colour '${hex}' has no readable text on it (best contrast ${ratio.toFixed(2)}:1, WCAG-AA needs ${AA_NORMAL}:1). A control filled with it can't carry legible white or dark text — pick a colour a text colour clears AA on.`,
          { node: prop, property: "value", code: "loom.a11y-theme-contrast" },
        );
      }
    }
  }
}
