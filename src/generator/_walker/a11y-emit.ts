// ---------------------------------------------------------------------------
// A11y attribute EMITTERS — the emit-side twin of the per-primitive a11y
// contract (`a11y.ts`, `A11yObligation`).  Where `a11y.ts` DECLARES the
// obligation a primitive carries, this module RENDERS the ARIA that clears it,
// so the semantics live in one place instead of being hand-copied into each
// design-pack template (accessibility.md — "one contract, every frontend").
//
// The strings here are HTML-ish attribute fragments (leading space included),
// which every JSX/markup frontend shares verbatim — React JSX, Vue, Svelte,
// Angular templates, and Phoenix HEEx all spell `aria-hidden="true"` /
// `role="img"` identically.  Feliz (F#/Fable) is the one frontend whose markup
// is not HTML — it renders `prop.ariaHidden true` etc. — so it builds the same
// obligations from its own leaf helpers rather than consuming these strings.
// ---------------------------------------------------------------------------

/** Escape a string for a double-quoted HTML/JSX attribute value.  Covers the
 *  four characters that would break out of `attr="…"` in any of the HTML-ish
 *  frontends; safe for React JSX (which HTML-escapes string attributes too). */
export function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** An ` aria-label="…"` attribute fragment, or the empty string when no name
 *  is supplied.  Used by any primitive that accepts an explicit `label:` hint to
 *  override or supply its accessible name (a command `Button`/`Action` whose
 *  visible text is a glyph, an icon-only control, etc.). */
export function ariaLabelAttr(label: string | undefined): string {
  if (label === undefined || label === "") return "";
  return ` aria-label="${escapeHtmlAttr(label)}"`;
}

/** The a11y attribute fragment for the `Toolbar` primitive.  Its contract
 *  (`{ role: "toolbar", needsName: true }`) makes it a labelled ARIA toolbar —
 *  a screen reader announces the grouped controls as a toolbar and can jump to
 *  it.  The accessible name isn't derivable from the IR, so it defaults to
 *  "Actions" (the canonical page-header action cluster) and is overridable with
 *  a `label:` hint when a page carries more than one. */
export function toolbarA11yAttr(opts: { label?: string }): string {
  const name = opts.label && opts.label !== "" ? opts.label : "Actions";
  return ` role="toolbar" aria-label="${escapeHtmlAttr(name)}"`;
}

/** The a11y attribute fragment for the `Icon` primitive.  Loom's `Icon` is
 *  decorative-by-default (its contract's `decorativeByDefault`): a glyph next
 *  to a labelled control conveys nothing to a screen reader and must be hidden,
 *  or it double-announces.  A meaning-bearing standalone icon opts out with a
 *  `label:` hint, which turns it into a named `img` (accessibility.md open
 *  question 1 — derive-from-default, explicit `label:` for the exception).
 *  `decorative: true` forces hidden even when a stray `label:` is present. */
export function iconA11yAttr(opts: { label?: string; decorative?: boolean }): string {
  if (opts.label !== undefined && opts.label !== "" && !opts.decorative) {
    return ` role="img" aria-label="${escapeHtmlAttr(opts.label)}"`;
  }
  return ` aria-hidden="true"`;
}
