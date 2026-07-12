// ---------------------------------------------------------------------------
// Per-pack token-contrast gate — accessibility.md Layer 2 / Phase 5
// ("Pack contrast check — a token-level WCAG-AA contrast assertion per pack
// theme, run in the lint job").
//
// The a11y proposal's zero-effort default (a fresh `ddd generate system`
// produces a WCAG 2.2 AA-conformant app) can only hold if the DESIGN TOKENS
// every pack projects clear AA in the first place — no amount of correct markup
// rescues unreadable colours.  Every built-in pack renders the SAME resolved
// palette (`prepareThemeVM` — the SSOT for the default `theme {}` tokens), so
// this gate asserts, per pack, that the tokens it ships satisfy the AA contrast
// contract the packs' surfaces rely on.  A future token-default regression
// (someone lightens the brand default below button-readability) fails here,
// statically, in the lint job — long before axe would catch it at runtime.
//
// Scope is deliberately TOKEN-LEVEL (accessibility.md Open Question #2 — "Start
// with token-level; component-state contrast is fuzzier").  We assert that each
// filled surface HAS a readable standard text colour (the pack picks light or
// dark), that the brand reads as text on the light surface, and that body text
// clears AA — not every component-state combination.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { prepareThemeVM } from "../../../src/generator/_frontend/theme-preparer.js";
import { BUILTIN_PACK_FORMATS } from "../../../src/util/builtin-formats.js";
import { AA_NORMAL, bestForegroundRatio, contrastRatio } from "../../../src/util/color.js";

// The two standard text colours a pack pairs with a coloured surface: a light
// (near-white) and a dark (near-black "ink").  A surface is usable when one of
// them clears AA on it.  These mirror the packs' own conventions (Tailwind
// `text-zinc-800` ink on light surfaces; white text on dark fills).
const LIGHT = "#ffffff";
const INK = "#0f172a";

// The default palette every built-in pack projects when the system declares no
// `theme {}` overrides — the "zero-effort default" the proposal guarantees.
const theme = prepareThemeVM(undefined);

// Coloured roles rendered as FILLED surfaces (primary buttons, semantic badges
// / alerts).  Shade index 6 is the light-scheme fill; index 5 is the dark-
// scheme fill (see the vuetify pack: `primary: brandShades[6]` light /
// `[5]` dark).  Both must host readable text so a pack in either scheme is AA.
const FILLED_ROLES = [
  "brandShades",
  "neutralShades",
  "secondaryShades",
  "accentShades",
  "successShades",
  "warningShades",
  "errorShades",
] as const;
const FILL_INDICES = [5, 6] as const;

describe("design-token WCAG-AA contrast (default palette)", () => {
  it("every filled surface token hosts a readable standard text colour", () => {
    const failures: string[] = [];
    for (const role of FILLED_ROLES) {
      const shades = theme[role];
      for (const idx of FILL_INDICES) {
        const surface = shades[idx]!;
        const ratio = bestForegroundRatio(surface, LIGHT, INK);
        if (ratio < AA_NORMAL) {
          failures.push(`${role}[${idx}] ${surface}: best foreground only ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures, `filled surfaces below AA (${AA_NORMAL}:1):\n${failures.join("\n")}`).toEqual(
      [],
    );
  });

  it("the brand reads as text/links on the light surface", () => {
    // Primary-coloured text (links, primary buttons rendered as text) must
    // clear AA against white — the light-scheme fill index.
    const brand = theme.brandShades[6]!;
    expect(contrastRatio(brand, LIGHT)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("body text clears AA on the light surface", () => {
    // Packs render body text with a dark neutral (`text-zinc-800`-ish); the
    // neutral ramp's dark shades must clear AA on white.
    for (const idx of [7, 8, 9] as const) {
      const text = theme.neutralShades[idx]!;
      expect(
        contrastRatio(text, LIGHT),
        `neutralShades[${idx}] ${text} on ${LIGHT}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});

// Per-pack coverage: every built-in pack projects the palette above, so the
// contract holds for each.  Enumerating the packs makes the gate's coverage
// explicit — a new pack that ships a DIVERGENT token default (its own palette
// rather than `prepareThemeVM`'s) surfaces here as a prompt to extend this gate
// with that pack's tokens, rather than silently shipping unchecked colours.
describe("per-pack token contrast", () => {
  const packs = Object.keys(BUILTIN_PACK_FORMATS);

  it("covers every built-in pack", () => {
    expect(packs.length).toBeGreaterThan(0);
  });

  for (const pack of packs) {
    it(`${pack}: filled tokens clear AA`, () => {
      const failures: string[] = [];
      for (const role of FILLED_ROLES) {
        for (const idx of FILL_INDICES) {
          const surface = theme[role][idx]!;
          if (bestForegroundRatio(surface, LIGHT, INK) < AA_NORMAL) {
            failures.push(`${role}[${idx}] ${surface}`);
          }
        }
      }
      expect(failures, `${pack} tokens below AA:\n${failures.join("\n")}`).toEqual([]);
    });
  }
});
