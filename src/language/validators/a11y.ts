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
import type { BuilderCall, Model } from "../generated/ast.js";

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
