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
import { iconA11yAttr } from "../a11y-emit.js";
import { lookupBuiltinIcon } from "../icons.js";
import { renderPrimitive } from "../render-primitive.js";
import { boolNamed, stringNamed } from "../shared/args.js";
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
  return renderPrimitive(ctx, "primitive-icon", {
    svg,
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
    // The HTML/markup packs (React/Vue/Svelte/Angular) consume the pre-rendered
    // `a11yAttr` fragment; Feliz (non-HTML markup) reads the raw `label` /
    // `decorative` to build its own F# `prop.*` props.
    a11yAttr: iconA11yAttr({ label, decorative }),
    label,
    decorative,
  });
}
