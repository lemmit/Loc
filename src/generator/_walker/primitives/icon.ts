// Icon primitive — inline SVG, either looked up from the builtin
// registry by name OR rendered from a user-supplied literal.
//
//   Icon { name: "github", size: "md" }
//   Icon { svg: "<svg viewBox='0 0 24 24'>...</svg>", size: "sm" }
//
// Lookup precedence: `svg:` wins when both are set (the user is
// explicitly overriding the registry).  Unknown `name:` keys fall
// through to a visible JSX comment so the gap is loud.
//
// Renders through the pack's `primitive-icon` template, which wraps
// the SVG in a `<span class="loom-icon">` so design packs can size
// + colour icons via CSS rather than each pack having to know the
// icon's intrinsic dimensions.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { localizedAriaLabelAttr, localizedNamedValue } from "../i18n-emit.js";
import { lookupBuiltinIcon } from "../icons.js";
import { renderPrimitive } from "../render-primitive.js";
import { boolNamed, namedArgValue, stringNamed } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { testidAttr } from "../walker-core.js";

export function emitIcon(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  void depth;
  const name = stringNamed(call, "name");
  const customSvg = stringNamed(call, "svg");
  const size = stringNamed(call, "size");
  const label = stringNamed(call, "label");
  const decorative = boolNamed(call, "decorative");

  // User-supplied SVG wins.  Falling back to the registry lookup
  // lets the typical "named icon" call stay terse while custom SVG
  // remains an escape hatch.
  const svg = customSvg ?? (name !== undefined ? lookupBuiltinIcon(name) : undefined);
  if (svg === undefined) {
    // Unknown name + no `svg:` literal — emit a visible comment so
    // the gap is loud at review time.  Pages still compile.
    const hint = name ? `unknown icon name '${name}'` : `Icon needs name: or svg:`;
    return ctx.target.renderComment(`${hint}`);
  }
  // Decorative-by-default (the `Icon` a11y contract): a glyph beside a labelled
  // control conveys nothing and must be hidden, or it double-announces.  A
  // `label:` opts out and turns the icon into a NAMED `role="img"`.
  //
  // Presence is read off the ARG, not off `stringNamed`'s literal: a dynamic
  // `label: row.kind` is still the author asking for a named icon, and folding
  // it back to `aria-hidden` would silently discard the request — the same
  // dead-name class `localizedAriaLabelAttr` fixed on `Button`.  An EMPTY
  // literal names nothing, so it stays decorative rather than becoming an
  // unnamed `role="img"` (which is strictly worse than a hidden glyph).
  const named = namedArgValue(call, "label") !== undefined && label !== "" && decorative !== true;
  return renderPrimitive(ctx, "primitive-icon", {
    svg,
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
    // Two spellings of ONE accessible name (D-I18N-ATTR), both derived from the
    // same `messageKey()` the extraction pass uses: the HTML-ish FRAGMENT the
    // `.hbs` packs splice, and the target-native VALUE the procedural packs
    // (Feliz's F# props, Flutter's `semanticLabel:`) build a prop from.
    a11yAttr: named
      ? ` role="img"${localizedAriaLabelAttr(call, ctx, "iconLabel")}`
      : ` aria-hidden="true"`,
    ariaLabelExpr: named ? localizedNamedValue(call, ctx, "iconLabel") : undefined,
  });
}
