// Leaf text & media primitives: Heading, Text, Money, DateDisplay,
// EnumBadge, Anchor, Image, Avatar, Loader, Empty, KeyValueRow. Each
// renders through the active design pack; KeyValueRow recurses into a
// value child via the shared `walk`.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { giveUp } from "../give-up.js";
import { localizedChromeAria, localizedPositionalAttr, localizedText } from "../i18n-emit.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  boolNamed,
  namedArgValue,
  numericNamed,
  positionalArgs,
  stringNamed,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import {
  emitExpr,
  navArgValue,
  navAttrFragment,
  styleAttr,
  styleWith,
  testidAttr,
  walk,
} from "../walker-core.js";

/** Read a named arg as an attribute VALUE — ANY expression, via `navArgValue`
 *  (the A12 machinery `Anchor`/`Button`'s `to:` already rides), not the pre-A12
 *  `stringOrRefArgValue` `Image`/`Avatar` were still on (M-T1.26): a computed
 *  value (`src: "/img/" + slug`) came back `undefined` and was silently
 *  dropped, and a route-param ref came back as a JS TEMPLATE LITERAL
 *  (`` `${id}` ``) — invalid F#/Dart, AND invalid in a markup attribute
 *  position on every JSX-family target too (confirmed against `tsc`: a bare
 *  `` src=`${id}` `` fails to parse as JSX at all, braces or not).
 *
 *  Every `Image`/`Avatar` pack template hardcodes the attribute NAME and `=`
 *  (` src={{{src}}}`, unlike `Anchor`'s `{{{navAttr "to"}}}`, which lets
 *  `navAttrFragment` spell the WHOLE fragment including the name) — so unlike
 *  `navArgValue`'s callers, this can only complete what the template already
 *  started.  For the LITERAL case that's exactly `nav.expr` (byte-identical:
 *  `ctx.target.exprLiteral("string", …)` is `JSON.stringify` on every
 *  JSX-family target, the same output `stringOrRefArgValue` produced).  For a
 *  DYNAMIC value, `src=` + a bare expression is invalid JSX/Svelte too — so
 *  those two targets get the value brace-wrapped (`src=` + `{expr}` =
 *  `src={expr}`, valid).  Feliz/Flutter consume `src`/`alt` as a raw
 *  expression in their own language (their packs read the value directly, not
 *  spliced markup), so the bare `nav.expr` is already correct there.
 *
 *  Vue and Angular remain UNFIXED for a dynamic value: they need a differently
 *  SPELLED attribute (`:src="expr"` / `[src]="expr"`), which requires the `=`
 *  the template hardcodes to not be there at all — an `{{{srcAttr}}}`-shaped
 *  template change (mirroring `{{{navAttr "to"}}}`) across every pack's
 *  `primitive-image.hbs`/`primitive-avatar.hbs`, out of this file's reach.
 *  See the M-T1.26 hand-off note for the exact shape. */
function attrArgValue(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const nav = navArgValue(call, name, ctx);
  return nav && attrExprValue(nav, ctx);
}

/** The brace-wrap decision `attrArgValue` applies to a `NavTarget` — shared
 *  with `emitImage`'s positional `src` shorthand (`Image { row.thumbnailUrl }`),
 *  which reads a bare positional `ExprIR` rather than a named arg. */
function attrExprValue(nav: { expr: string; dynamic: boolean }, ctx: WalkContext): string {
  if (!nav.dynamic) return nav.expr;
  if (ctx.target.framework === "react" || ctx.target.framework === "svelte") {
    return `{${nav.expr}}`;
  }
  return nav.expr;
}

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
  void depth;
  return renderPrimitive(ctx, "primitive-empty", {
    text: localizedText(call, ctx, "empty", '"No results."'),
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
    // Pack-chrome: the spinner's `aria-label="Loading"` translates through the
    // shared `chrome.loading` catalog under i18n (M-T1.11), else byte-identical.
    loadingAria: localizedChromeAria(ctx, "loading", "Loading"),
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
  //
  // `to:` takes ANY expression (`to: "/greet/" + who`), not just a literal path:
  // the pack splices the destination through `{{{navAttr "<attr>"}}}`, which
  // spells a static path as a plain attribute and a computed one as the
  // framework's bound attribute (A12).
  void depth;
  const nav = navArgValue(call, "to", ctx);
  if (nav) ctx.usesRouterLink = true;
  return renderPrimitive(ctx, "primitive-anchor", {
    label: localizedText(call, ctx, "anchor", '"link"'),
    // The pack names the attribute; the walker owns its framework spelling.
    navAttr: (name: unknown) => navAttrFragment(nav, ctx, String(name)),
    // The destination as a bare EXPRESSION in the target's own language — what
    // the two procedural packs (Feliz's `prop.href`, Flutter's `pushNamed`)
    // consume, since neither renders HTML attributes.
    to: nav?.expr,
    hasTo: nav !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitImage(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Image(src: "...", alt: "...") — packs render a styled image tag.  Both
  // attrs accept ANY expression (A12 semantics — `attrArgValue`), not just a
  // string literal or a bare ref.  The first POSITIONAL arg is shorthand for
  // `src` (`Image { "/logo.png" }`, or `Image { row.thumbnailUrl }`),
  // mirroring how Text/Money/EnumBadge read their primary value.
  void depth;
  const positional = positionalArgs(call)[0];
  const positionalSrc = positional
    ? attrExprValue(
        positional.kind === "literal" && positional.lit === "string"
          ? { expr: ctx.target.exprLiteral("string", positional.value), dynamic: false }
          : { expr: emitExpr(positional, ctx), dynamic: true },
        ctx,
      )
    : undefined;
  const src = attrArgValue(call, "src", ctx) ?? positionalSrc;
  // `decorative: true` (accessibility.md) renders an explicit empty
  // alt (`alt=""`), hiding a purely-decorative image from assistive tech; a
  // real `alt:` wins over it.  The validator guarantees one of the two is
  // present when the image has a src.
  const alt = attrArgValue(call, "alt", ctx) ?? (boolNamed(call, "decorative") ? '""' : undefined);
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
  // Avatar(src: "...", alt: "...") — packs render a circle-cropped image.
  // Both attrs accept ANY expression (A12 semantics — `attrArgValue`).
  // Without src, packs render their user-icon fallback.
  void depth;
  const src = attrArgValue(call, "src", ctx);
  // `decorative: true` → explicit empty alt (see emitImage); real `alt:` wins.
  const alt = attrArgValue(call, "alt", ctx) ?? (boolNamed(call, "decorative") ? '""' : undefined);
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
  // `min(6, 2 + headingDepth)`, so levels never skip) rather
  // than a flat default.  At page top (depth 0) this is `<h2>`; the page
  // chrome owns the single `<h1>`.
  const text = localizedText(call, ctx, "heading", '"Heading"');
  const level = numericNamed(call, "level") ?? Math.min(6, 2 + (ctx.headingDepth ?? 0));
  void depth;
  // Explicit typography control, decoupled from the semantic level.
  // `size:` overrides the level's default size; `weight:` sets the
  // font weight; `gradient:` applies a CSS gradient as the text fill
  // via `background: <gradient>; background-clip: text; color:
  // transparent` on the rendered element.
  const size = stringNamed(call, "size");
  const weight = numericNamed(call, "weight");
  const gradient = stringNamed(call, "gradient");
  return renderPrimitive(ctx, "primitive-heading", {
    text,
    level,
    size,
    hasSize: size !== undefined,
    weight,
    hasWeight: weight !== undefined,
    gradient,
    hasGradient: gradient !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
    // `gradient:` / `weight:` become pack-authored CSS declarations, which used
    // to be emitted as a hardcoded `style="…"` NEXT TO `{{{styleAttr}}}` — two
    // `style` attributes on one element (F2).  `styleWith` merges them.
    styleWith: styleWith(call, ctx),
  });
}

export function emitText(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  void depth;
  return renderPrimitive(ctx, "primitive-text", {
    text: localizedText(call, ctx, "text", '""'),
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** `Bold { "..." }` — inline strong-emphasis span.  Same shape as
 *  `emitText`; lowers to the pack-specific `<strong>` equivalent. */
export function emitBold(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  void depth;
  return renderPrimitive(ctx, "primitive-bold", {
    text: localizedText(call, ctx, "bold", '""'),
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
  void depth;
  return renderPrimitive(ctx, "primitive-italic", {
    text: localizedText(call, ctx, "italic", '""'),
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
  void depth;
  return renderPrimitive(ctx, "primitive-inline-code", {
    text: localizedText(call, ctx, "code", '""'),
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
  // The VALUE slot splits two ways.  A nested primitive (`KeyValueRow { "Total",
  // Money { o.total } }`) is an ELEMENT and walks; a plain string LITERAL is
  // authored PROSE and must translate — `Stat { "Status", "Open" }` t()-wraps
  // both halves, and the visually identical `KeyValueRow { "Status", "Open" }`
  // shipped `"Open"` raw and absent from `.loom/messages.en.json` (G2667 §D9:
  // two rows that render the same, one translatable and one not, with nothing
  // in the DSL to tell the author which they wrote).  Routed through the same
  // `localizedText` the label uses, under its own `keyValueValue` role so the
  // two halves of a row keep distinct catalog keys — exactly the
  // `statLabel`/`statValue` split.  With i18n off `localizedRawOf` falls
  // through to `renderTextContent`, which spells a string literal the same way
  // `walk` does, so non-i18n output is byte-identical.
  const childIsLiteral = childArg?.kind === "literal" && childArg.lit === "string";
  const childJsx = childArg
    ? childIsLiteral
      ? localizedText(call, ctx, "keyValueValue", '""', 1)
      : walk(childArg, ctx, depth + 2)
    : giveUp(ctx.target, "missing value");
  return renderPrimitive(ctx, "primitive-key-value-row", {
    // The label is a user-visible slot (`keyValue`), and the packs split on how
    // they render it — a `<span>` on the seven layout-markup packs, a component
    // PROP on the eight that delegate to a `<KeyValueRow>`.  So both spellings
    // of the one name are supplied, from the same `messageKey()`:
    //   `label`     — the text/children token, for `<span>{{{label}}}</span>`;
    //   `labelAttr` — the complete bound attribute, for `<KeyValueRow{{{labelAttr}}}>`.
    label: localizedText(call, ctx, "keyValue", '""'),
    // A missing label emits `label=""` rather than dropping the attribute.
    labelAttr: labelArg ? localizedPositionalAttr(call, ctx, "keyValue", "label") : ' label=""',
    childJsx,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
