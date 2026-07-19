// FileLink(<file-expr>) — a plain HTML download anchor for a `File` field.
//
// A file download is a native `<a href download>`, NOT a design-system
// component, so the JSX/markup frontends (React / Vue / Svelte / Angular)
// build the markup INLINE through the target's markup seams — no per-pack
// `.hbs` template (unlike `IdLink`, which wraps a framework `RouterLink`).
// The two non-JSX frontends fork the whole primitive: Feliz (F#, emits
// `Html.a`) via the `renderFileLink` WalkerTarget override; Phoenix/HEEx via
// its parallel walker (`heex-primitives.ts::renderFileLink`).

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { namedArgValue, positionalArgs } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, testidAttr } from "../walker-core.js";

/** `FileLink(<file-ref>)` — render a download anchor from a `File`-typed
 *  expression (`data.blob`).  The value is the `FileRef` wire object
 *  `{ url, key, contentType, size }`; the anchor hrefs `.url` and labels with
 *  `.key`.  Null-guarded: an optional `File?` that is null renders an em-dash
 *  instead of a broken anchor (a required `File` is always truthy, so the
 *  guard is a harmless always-true — one code path covers both). */
export function emitFileLink(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Feliz (F#, not JSX markup) forks the whole primitive.
  const override = ctx.target.renderFileLink?.(call, ctx, depth);
  if (override != null) return override;

  const arg = namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const recv = arg ? emitExpr(arg, ctx) : '""';
  const href = ctx.target.renderAttrBinding("href", `${recv}.url`);
  const label = ctx.target.renderInterpolation(`${recv}.key`);
  const anchor = `<a${href} download${testidAttr(call, ctx)}>${label}</a>`;
  // The null placeholder rides a bare `<span>` — plain markup that is valid in
  // every target's conditional-child arm (a JS expression on React, a template
  // fragment on Vue/Svelte/Angular).  `escapeText` leaves the em-dash intact.
  const dash = `<span>${ctx.target.escapeText("—")}</span>`;
  return ctx.target.renderConditionalChild(recv, anchor, dash, depth);
}
