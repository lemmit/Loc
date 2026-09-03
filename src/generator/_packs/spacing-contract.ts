// ---------------------------------------------------------------------------
// The cross-pack spacing and chrome contract.
//
// WHY THIS FILE EXISTS
// --------------------
// Every design pack was written independently, so the SAME page rendered
// through two packs came out at two different rhythms: the root page `Stack`
// measured 0px (mui), 8px (chakra), 12px (vuetify) and 16px (mantine, shadcn,
// flowbite) on one identical `.ddd`; a `Group` measured 4/8/12/16 because the
// literal `1` was copy-pasted between packs whose spacing UNIT differs (MUI's
// is 8px, Chakra's token `1` is 4px); and two of eight packs wrapped a wide
// table in a scroll container, so the other six scrolled the whole DOCUMENT
// sideways on a phone.
//
// The promise Loom makes is "same model, same page, different skin".  That
// holds structurally but not visually unless ONE contract says what the
// spacing means and every pack resolves to it.  This module is that contract
// in machine-readable form; `docs/design-packs.md` § "Spacing and chrome
// contract" is the same thing in prose, and
// `test/generator/_packs/pack-spacing-contract.test.ts` is the gate that
// resolves each pack's own spelling back to these numbers.
//
// HOW A PACK SATISFIES IT
// -----------------------
// By declaring the spacing EXPLICITLY in its own dialect — `gap="md"`
// (mantine), `gap={2}` (mui, unit 8), `gap={4}` (chakra, unit 4), `gap-4`
// (tailwind, unit 4), `ga-4` (vuetify, unit 4), `gap: 16px` (the Angular
// packs' `loom-*` CSS).  A pack may NOT satisfy the contract by inheriting a
// library default: an unstated gap is what let four packs drift in the first
// place, and a library upgrade would move it silently.
//
// This file is pure data with no imports so it stays browser-safe (the
// playground compiles packs too) and readable from the test tier.
// ---------------------------------------------------------------------------

/** The spacing scale, in CSS pixels.  Deliberately the intersection of the
 *  scales the shipped libraries already use — every value is expressible in
 *  every pack's dialect without an arbitrary/escape-hatch value. */
export const SPACING_SCALE = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export type SpacingToken = keyof typeof SPACING_SCALE;

/** Resolution tolerance for the gate, in px.  Zero would be defensible for
 *  the template-level gate (the spellings resolve exactly), but the DOM-level
 *  measurement post-step reads COMPUTED values, where a library's own
 *  rounding of a rem value lands a pixel out.  One band for both keeps the
 *  contract a single number rather than two. */
export const SPACING_TOLERANCE_PX = 2;

/** One governed concern.  `token` present ⇒ the concern resolves to a number
 *  of pixels; `token` absent ⇒ the concern is structural (a shape the markup
 *  must have, not a distance). */
export interface SpacingRule {
  /** The scale entry this concern must resolve to, when it is numeric. */
  readonly token?: SpacingToken;
  /** What the rule governs, in one line — the text `docs/design-packs.md`
   *  expands on and the gate quotes in its failure message. */
  readonly what: string;
}

/** Pixels for a rule, or `undefined` for a structural one. */
export function rulePx(rule: SpacingRule): number | undefined {
  return rule.token === undefined ? undefined : SPACING_SCALE[rule.token];
}

/**
 * The contract.  Two rhythms, one page:
 *
 * - `md` (16px) separates BLOCKS — the stack of things down a page, the
 *   inside padding of a surface, the distance from the last form field to
 *   its submit row.
 * - `sm` (8px) separates ADJACENT CONTROLS — buttons in a row, a label from
 *   its value.
 *
 * Anything else is a deviation, and the gate names it.
 */
export const SPACING_CONTRACT = {
  "stack.gap": {
    token: "md",
    what: "vertical gap between a page `Stack`'s children (the page's block rhythm)",
  },
  "group.gap": {
    token: "sm",
    what: "horizontal gap between adjacent controls in a `Group`",
  },
  "toolbar.gap": {
    token: "md",
    what: "gap between a `Toolbar`'s title side and its actions side",
  },
  "toolbar.alignment": {
    what: "a `Toolbar` is a row: cross-axis centred, main-axis space-between",
  },
  "paper.padding": {
    token: "md",
    what: "inner padding of a `Paper` surface",
  },
  "card.padding": {
    token: "md",
    what: "inner padding of a `Card` body (and of its header, when the pack splits them)",
  },
  "keyValueRow.gap": {
    token: "sm",
    what: "gap between a `KeyValueRow`'s label and its value — the two sit ADJACENT (a fixed label column), never pushed apart by space-between",
  },
  "formSubmitRow.marginTop": {
    token: "md",
    what: "distance from the last form field to the submit row",
  },
  "formSubmitRow.gap": {
    token: "sm",
    what: "gap between the buttons in a form's submit row",
  },
  "main.padding": {
    token: "lg",
    what: "padding of the app shell's `<main>` region at the `lg` breakpoint and above (one step down — `md` — below it)",
  },
  "main.paddingMobile": {
    token: "md",
    what: "padding of the app shell's `<main>` region below the `lg` breakpoint",
  },
  "main.contained": {
    what: "the `<main>` region sets `min-width: 0` so a wide child scrolls INSIDE its own container instead of widening the document",
  },
  "table.scrollContainer": {
    what: "a `Table` is wrapped in a full-width `overflow-x: auto` container, so a wide table scrolls itself and a phone never scrolls the document sideways",
  },
  "container.size": {
    what: "`Container { size: … }` reaches the rendered max-width — a pack may not drop the author's size",
  },
  "breadcrumbs.semantics": {
    what: "breadcrumbs are a named `nav` around a list, with a separator between crumbs",
  },
  "navSection.label": {
    what: "a sidebar section label is a muted uppercase `xs`-size label — not a link, not a divider caption",
  },
  "chart.integerAxis": {
    what: "a chart whose plotted series is integral draws integer ticks (no 0.2 steps on a count series)",
  },
} as const satisfies Record<string, SpacingRule>;

export type SpacingConcern = keyof typeof SPACING_CONTRACT;

/** The typography half of the contract — the `heading level:` ladder, in px.
 *  Included here (rather than in a second module) because it is measured the
 *  same way, by the same gate, and diverged for the same reason: one
 *  `heading level: 2` spanned 14px → 60px across four packs. */
export const HEADING_SCALE_PX = {
  1: 30,
  2: 24,
  3: 20,
  4: 16,
  5: 14,
  6: 12,
} as const;

/** Font-size tolerance for the heading ladder, in px.  Wider than the spacing
 *  band because a library's heading sizes are rem-based and land on their own
 *  rounded steps (Mantine's h2 is 1.625rem = 26px against a 24px target); the
 *  band rejects the divergences that were actually found (14px, 60px) without
 *  forcing a pack off its own type scale. */
export const HEADING_TOLERANCE_PX = 4;
