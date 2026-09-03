// FileLink(<file-expr>) — a plain HTML download anchor for a `File` field.
//
// A file download is a native `<a href download>`, NOT a design-system
// component, so the JSX/markup frontends (React / Vue / Svelte / Angular)
// build the markup INLINE through the target's markup seams — no per-pack
// `.hbs` template (unlike `IdLink`, which wraps a framework `RouterLink`).
// The two non-JSX frontends fork the whole primitive: Feliz (F#, emits
// `Html.a`) via the `renderFileLink` WalkerTarget override; Phoenix/HEEx via
// its parallel walker (`heex-primitives.ts::renderFileLink`).

import type { ExprIR, TypeIR } from "../../../ir/types/loom-ir.js";
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
  // The two reads sit INSIDE the truthiness guard below, so they can never run
  // on a null ref — but a type-checker has to be able to see that, and Angular
  // cannot: the receiver of a scaffolded page's file field is rooted at a
  // signal CALL (`byId.data()!.blob`), and Angular narrows no member chain
  // across a call result (same limitation `renderQueryDataAccess` documents).
  // So the reads are offered to the target as reads off an OPTIONAL `File`,
  // which is exactly what the guard exists for; a target that spells those
  // null-safe gets `blob?.url`, and one that doesn't keeps the plain access.
  const fileRef: TypeIR = { kind: "optional", inner: { kind: "primitive", name: "File" } };
  const read = (member: string): string =>
    ctx.target.renderMemberRead?.({
      receiver: recv,
      member,
      receiverType: fileRef,
      memberType: undefined,
    }) ?? `${recv}.${member}`;
  const href = ctx.target.renderAttrBinding("href", read("url"));
  const label = ctx.target.renderInterpolation(read("key"));
  const anchor = `<a${href} download${testidAttr(call, ctx)}>${label}</a>`;
  // The null placeholder rides a bare `<span>` — plain markup that is valid in
  // every target's conditional-child arm (a JS expression on React, a template
  // fragment on Vue/Svelte/Angular).  `escapeText` leaves the em-dash intact.
  const dash = `<span>${ctx.target.escapeText("—")}</span>`;
  return ctx.target.renderConditionalChild(recv, anchor, dash, depth);
}
