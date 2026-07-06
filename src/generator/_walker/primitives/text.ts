// Leaf text & media primitives: Heading, Text, Money, DateDisplay,
// EnumBadge, Anchor, Image, Avatar, Loader, Empty, KeyValueRow. Each
// renders through the active design pack; KeyValueRow recurses into a
// value child via the shared `walk`.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  boolNamed,
  escapeJsxText,
  namedArgValue,
  numericNamed,
  positionalArgs,
  stringNamed,
  unwrapTextLiteral,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import {
  emitExpr,
  firstPositionalContent,
  stringOrRefArgValue,
  styleAttr,
  testidAttr,
  walk,
} from "../walker-core.js";

export function emitMoney(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const value = namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const valueExpr = value ? emitExpr(value, ctx) : "0";
  const currency = stringNamed(call, "currency");
  const decimals = numericNamed(call, "decimals");
  return renderPrimitive(ctx, "primitive-money", {
    valueExpr,
    hasCurrency: currency !== undefined,
    currency: currency !== undefined ? JSON.stringify(currency) : "",
    hasDecimals: decimals !== undefined,
    decimals: decimals !== undefined ? String(decimals) : "",
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** DateDisplay(iso, testid?).  Renders through the
 *  pack's `DateTimeValue` runtime helper (locale-formatted with
 *  the raw ISO surfaced in a tooltip).  Accepts a string or null;
 *  empty values render as the shared dimmed em-dash. */
export function emitDateDisplay(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const value = namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const valueExpr = value ? emitExpr(value, ctx) : '""';
  return renderPrimitive(ctx, "primitive-date-display", {
    valueExpr,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** EnumBadge(value, color?, testid?).  Renders the
 *  per-pack Badge with an optional explicit colour.  Mantine
 *  passes `color={…}`; shadcn maps `color` to the Badge `variant`
 *  prop in the template (so the same DSL surface works on both
 *  packs). */
export function emitEnumBadge(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const value = namedArgValue(call, "value") ?? positionalArgs(call)[0];
  const valueExpr = value ? emitExpr(value, ctx) : '""';
  const color = stringNamed(call, "color");
  return renderPrimitive(ctx, "primitive-enum-badge", {
    valueExpr,
    hasColor: color !== undefined,
    color: color !== undefined ? JSON.stringify(color) : "",
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitEmpty(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Empty("No results yet") — empty-state placeholder.  No
  // dedicated component on either pack; both compose a centred
  // dimmed text block.  The first positional is the message;
  // refs / ops welcome (routes through renderTextContent).
  const msg = firstPositionalContent(call, ctx) ?? '"No results."';
  void depth;
  return renderPrimitive(ctx, "primitive-empty", {
    text: unwrapTextLiteral(msg, ctx.target.escapeText),
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitLoader(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Loader() — spinner.  Optional `size:` string literal.
  void depth;
  const size = stringNamed(call, "size");
  return renderPrimitive(ctx, "primitive-loader", {
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitAnchor(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Anchor("label", to: "/path") — text-style link.  With `to:`,
  // routes via React Router's Link; without, falls through to a
  // bare anchor (no href — visible no-op).
  void depth;
  const label = firstPositionalContent(call, ctx) ?? '"link"';
  const to = stringOrRefArgValue(call, "to", ctx);
  if (to) ctx.usesRouterLink = true;
  return renderPrimitive(ctx, "primitive-anchor", {
    label: unwrapTextLiteral(label, ctx.target.escapeText),
    to,
    hasTo: to !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitImage(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Image(src: "...", alt: "...") — packs render a styled image
  // tag.  Both attrs accept string literals or refs.  The first
  // POSITIONAL arg is shorthand for `src` (`Image { "/logo.png" }`),
  // mirroring how Text/Money/EnumBadge read their primary value.
  void depth;
  const positional = positionalArgs(call)[0];
  const positionalSrc =
    positional?.kind === "literal" && positional.lit === "string"
      ? JSON.stringify(positional.value)
      : undefined;
  const src = stringOrRefArgValue(call, "src", ctx) ?? positionalSrc;
  // `decorative: true` (accessibility.md Phase 3) renders an explicit empty
  // alt (`alt=""`), hiding a purely-decorative image from assistive tech; a
  // real `alt:` wins over it.  The validator guarantees one of the two is
  // present when the image has a src.
  const alt =
    stringOrRefArgValue(call, "alt", ctx) ?? (boolNamed(call, "decorative") ? '""' : undefined);
  return renderPrimitive(ctx, "primitive-image", {
    src,
    alt,
    hasSrc: src !== undefined,
    hasAlt: alt !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitAvatar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Avatar(src: "...", alt: "...") — packs render a circle-cropped
  // image.  Without src, packs render their user-icon fallback.
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  // `decorative: true` → explicit empty alt (see emitImage); real `alt:` wins.
  const alt =
    stringOrRefArgValue(call, "alt", ctx) ?? (boolNamed(call, "decorative") ? '""' : undefined);
  return renderPrimitive(ctx, "primitive-avatar", {
    src,
    alt,
    hasSrc: src !== undefined,
    hasAlt: alt !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitHeading(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // First positional is the heading text — accepts a string
  // literal OR a ref (e.g. a route-param name).  Optional `level:`
  // named arg controls the heading rank (1..6); when absent the rank is
  // DERIVED from the `Section`/`Card` nesting depth (accessibility.md
  // Phase 2 — `min(6, 2 + headingDepth)`, so levels never skip) rather
  // than a flat default.  At page top (depth 0) this is `<h2>`; the page
  // chrome owns the single `<h1>`.
  const text = firstPositionalContent(call, ctx) ?? '"Heading"';
  const level = numericNamed(call, "level") ?? Math.min(6, 2 + (ctx.headingDepth ?? 0));
  void depth;
  // Phase 5 — explicit typography control decoupled from semantic level.
  // `size:` overrides the level's default size; `weight:` sets the
  // font weight; `gradient:` applies a CSS gradient as the text fill
  // via `background: <gradient>; background-clip: text; color:
  // transparent` on the rendered element.
  const size = stringNamed(call, "size");
  const weight = numericNamed(call, "weight");
  const gradient = stringNamed(call, "gradient");
  return renderPrimitive(ctx, "primitive-heading", {
    text: unwrapTextLiteral(text, ctx.target.escapeText),
    level,
    size,
    hasSize: size !== undefined,
    weight,
    hasWeight: weight !== undefined,
    gradient,
    hasGradient: gradient !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitText(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return renderPrimitive(ctx, "primitive-text", {
    text: unwrapTextLiteral(text, ctx.target.escapeText),
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** `Bold { "..." }` — inline strong-emphasis span.  Same shape as
 *  `emitText`; lowers to the pack-specific `<strong>` equivalent. */
export function emitBold(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return renderPrimitive(ctx, "primitive-bold", {
    text: unwrapTextLiteral(text, ctx.target.escapeText),
    testidAttr: testidAttr(call, ctx),
  });
}

/** `Italic { "..." }` — inline emphasis span.  Same shape as
 *  `emitText`; lowers to the pack-specific `<em>` equivalent. */
export function emitItalic(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return renderPrimitive(ctx, "primitive-italic", {
    text: unwrapTextLiteral(text, ctx.target.escapeText),
    testidAttr: testidAttr(call, ctx),
  });
}

/** `InlineCode { "..." }` — inline `<code>` span for mono-styled
 *  terms (e.g. `.ddd`, `docker compose`) embedded in running prose. */
export function emitInlineCode(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return renderPrimitive(ctx, "primitive-inline-code", {
    text: unwrapTextLiteral(text, ctx.target.escapeText),
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitKeyValueRow(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const positionals = positionalArgs(call);
  const labelArg = positionals[0];
  const childArg = positionals[1];
  const labelStr =
    labelArg && labelArg.kind === "literal" && labelArg.lit === "string" ? labelArg.value : "";
  const childJsx = childArg
    ? walk(childArg, ctx, depth + 2)
    : ctx.target.renderComment("missing value");
  return renderPrimitive(ctx, "primitive-key-value-row", {
    label: ctx.target.escapeText(labelStr),
    childJsx,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
