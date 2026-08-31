// Layout / surface primitives: Stack, Group, Grid, Container, Tabs,
// Toolbar, Card. Each renders a per-pack container and recurses into
// positional children (Tabs into each Tab's body, Card into its body)
// via the shared walk helpers.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { escapeHtmlAttr } from "../a11y-emit.js";
import {
  localizedAriaLabelAttr,
  localizedNamedValue,
  localizedPositionalAttr,
  localizedPositionalTranslation,
  localizedText,
} from "../i18n-emit.js";
import { renderPrimitive } from "../render-primitive.js";
import { gridCols, positionalArgs, slugify, stringNamed } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { positionalChildren, styleAttr, styleWith, testidAttr, walk } from "../walker-core.js";

/** Run `fn` with the walk one semantic heading-nesting level deeper — used
 *  by the `nesting: true` a11y-contract containers (`Section` / `Card`) so a
 *  `Heading` in their body derives a rank deeper (accessibility.md).
 *  Mutate-and-restore on the SAME context (not a spread copy) so every
 *  value-typed `Sink` flag a child writes (`usesNavigate`, `usesChildren`,
 *  …) still lands on the shared object — a shallow `{...ctx}` would silently
 *  drop those boolean writes. */
function withHeadingNesting<T>(ctx: WalkContext, fn: () => T): T {
  const prev = ctx.headingDepth ?? 0;
  ctx.headingDepth = prev + 1;
  try {
    return fn();
  } finally {
    ctx.headingDepth = prev;
  }
}

export function emitStack(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Every positional arg is a child; ignore named args in v0.
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-stack", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitGroup(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-group", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitGrid(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Each child wraps in a per-pack column container (Mantine's
  // <Grid.Col span="auto">; shadcn's plain `<div>` since gap is
  // on the parent).  `cols:` selects per-breakpoint column
  // counts; when absent, every child takes `span="auto"` and the
  // pack picks an equal-weight default.
  const children = positionalChildren(call, ctx, depth + 2);
  const colIndent = "  ".repeat(depth + 1);
  const childIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  const cols = gridCols(call);
  // Translate column counts to Mantine/MUI `span` values out of 12.
  // `floor(12 / N)` matches the on-screen ratios users intend; an N
  // greater than 12 clamps to 1 so the math stays sane.
  const spanFor = (n: number): number => Math.max(1, Math.floor(12 / Math.max(1, n)));
  return renderPrimitive(ctx, "primitive-grid", {
    hasChildren: children.length > 0,
    children,
    // Grid was the ONE children-bearing container that never passed
    // `childrenBlock` — the pre-joined form every sibling container supplies
    // (`Stack`/`Group`/`Section`/`Sticky`/`Container`/`Toolbar`).  The `.hbs`
    // packs iterate `{{#each children}}` (each child in its own column
    // wrapper), so they never noticed; the two PROCEDURAL packs read
    // `childrenBlock` through their shared container helpers — Feliz's
    // `containerEl` (`prop.children [ … ]`) and Flutter's `childrenList`
    // (`<Widget>[ … ]`) — and silently rendered an EMPTY grid.  Flutter's
    // was worse than silent: `<Widget>[\n,\n]` is a Dart syntax error.
    // Joined on `childIndent` because the children were walked at `depth + 2`
    // (the extra level is the per-child column wrapper the markup packs emit),
    // so the join indent stays self-consistent with the child bodies.
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${childIndent}`),
    // `indent` is the name the procedural helpers read for the same value.
    indent: childIndent,
    colIndent,
    childIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
    hasResponsiveCols: cols !== undefined,
    colsDesktop: cols?.desktop,
    colsTablet: cols?.tablet,
    colsMobile: cols?.mobile,
    spanDesktop: cols ? spanFor(cols.desktop) : undefined,
    spanTablet: cols ? spanFor(cols.tablet) : undefined,
    spanMobile: cols ? spanFor(cols.mobile) : undefined,
  });
}

export function emitSection(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Section(...children) — semantic anchor target.  The `id:` named
  // arg lands as the `<section id="...">` attribute so anchor links
  // (`Anchor { "Vision", to: "#vision" }`) scroll to the matching
  // section.  Renders as a plain `<section>` element through every
  // pack — the wrapping element shape is the same; only pack-specific
  // theming (if any) varies per template.
  const id = stringNamed(call, "id");
  // `Section` is a `nesting: true` container in the a11y contract — its
  // children's `Heading`s derive one rank deeper (accessibility.md).
  const children = withHeadingNesting(ctx, () => positionalChildren(call, ctx, depth + 1));
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-section", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    id,
    hasId: id !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitSticky(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Sticky(...children) — position:sticky wrapper.  The `top:` named
  // arg lands as a CSS offset (default "0").  Used to pin the landing
  // page's nav bar to the top on scroll.
  const top = stringNamed(call, "top") ?? "0";
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-sticky", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    top,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitContainer(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Container(...children) — max-width centred wrapper.  Optional
  // `size:` named arg controls the max-width per pack idiom
  // (Mantine "xs"|"sm"|"md"|"lg"|"xl"; shadcn maps to a tailwind
  // max-w utility).
  const children = positionalChildren(call, ctx, depth + 1);
  const size = stringNamed(call, "size");
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-container", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
    // Vuetify has no `size` prop on `<v-container>`, so its pack expresses the
    // size as its own `max-width` declaration.  `styleWith` merges the pack's
    // base declarations with the author's into ONE attribute — emitting it next
    // to `{{{styleAttr}}}` would produce two `style` attributes.
    styleWith: styleWith(call, ctx),
  });
}

/** The four spellings of a `Tab`'s CAPTION — a user-visible slot (`tabLabel`,
 *  M-T1.11) the packs render four different ways, so all four come from the
 *  SAME `messageKey()` and the same translation decision:
 *
 *    `label`     — the markup TEXT token (`<Tabs.Tab>{{{label}}}</Tabs.Tab>`);
 *    `labelAttr` — the complete bound ` label=…` attribute (MUI's `<Tab label=…/>`,
 *                  Angular Material's `<mat-tab label=…>`, which needs the
 *                  framework's own binding syntax, not a JSX brace);
 *    `titleAttr` — the same fragment under the `title` name, for the one pack
 *                  whose component spells the prop differently (flowbite's
 *                  `<TabItem title=…>`).  Two names rather than one generic
 *                  "attribute value" token because a Vue/Angular binding is
 *                  `:title` / `[title]`, which a value-only token cannot spell;
 *    `labelExpr` — the bare target-native EXPRESSION, always defined (the
 *                  translation call under i18n, the target's string literal
 *                  otherwise), for the packs that splice the caption into their
 *                  own syntax: a Svelte object literal, Feliz's `prop.ariaLabel`,
 *                  Flutter's `Tab(text: …)`.
 *
 *  `arg` is the `Tab(…)` call when its caption is a plain literal, `undefined`
 *  for the two chrome fallbacks (a non-literal caption, a bare positional child)
 *  — those are emitter-built `Tab N` text with no source string, so they carry
 *  no catalog key and always render static. */
function tabLabelForms(
  arg: (ExprIR & { kind: "call" }) | undefined,
  ctx: WalkContext,
  labelStr: string,
): { label: string; labelAttr: string; titleAttr: string; labelExpr: string } {
  const translation = arg ? localizedPositionalTranslation(arg, ctx, "tabLabel") : undefined;
  return {
    label: arg ? localizedText(arg, ctx, "tabLabel", '""') : ctx.target.escapeText(labelStr),
    labelAttr: arg
      ? localizedPositionalAttr(arg, ctx, "tabLabel", "label")
      : ` label="${escapeHtmlAttr(labelStr)}"`,
    titleAttr: arg
      ? localizedPositionalAttr(arg, ctx, "tabLabel", "title")
      : ` title="${escapeHtmlAttr(labelStr)}"`,
    labelExpr:
      translation ?? ctx.target.renderStringLiteral?.(labelStr) ?? JSON.stringify(labelStr),
  };
}

export function emitTabs(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Tabs(Tab("Overview", ...body), Tab("Settings", ...body))
  // Each positional child must be a `Tab(label, ...children)` call;
  // anything else lands as a placeholder so the page still
  // compiles.  Tab labels must be string literals in v0; non-
  // literal labels fall back to indexed slugs `tab-1`, …
  //
  // The panel body is EVERY remaining positional, not `tabPositionals[1]`
  // alone: a tab panel is a children container like `Stack`/`Card` and joins
  // its children the same way.  Taking only the first would render `A` and drop
  // `B` from `Tab { "Ovw", Text { "A" }, Text { "B" } }` on all seven targets,
  // silently — and the dropped literal would still reach
  // `.loom/messages.en.json`, handing translators a key nothing renders.
  const positionals = positionalArgs(call);
  const innerIndent = "  ".repeat(depth + 2);
  /** Join already-walked panel children the way every other container does. */
  const joinBody = (parts: readonly string[]): string =>
    parts.join(`${ctx.target.interChildSeparator ?? ""}\n${innerIndent}`);
  const tabs = positionals.map((arg, i) => {
    if (arg.kind !== "call" || arg.name !== "Tab") {
      // Bare positional (e.g. `Tabs(Card(...), Card(...))`) — treat it as
      // the panel body directly with an auto-generated label.  Without
      // this fallback, the panel would emit a JSX comment as its only
      // child and tsc rejects it (Mantine's `TabsPanelProps` requires
      // a non-empty `children`).
      const only = walk(arg, ctx, depth + 2);
      return {
        value: `tab-${i + 1}`,
        ...tabLabelForms(undefined, ctx, `Tab ${i + 1}`),
        bodyJsx: only,
        bodyChildren: [only],
      };
    }
    const tabPositionals = positionalArgs(arg);
    const labelArg = tabPositionals[0];
    // Positional 0 is the CAPTION only when it is text-like — the same rule
    // `emitCard` applies to its title (`titleIsTextLike`).  Reading it as the
    // caption unconditionally made an unrecognised NAMED argument SWALLOW the
    // tab's content: `Tab { title: "One", Text { "first" } }` puts nothing in
    // positional 0 but the `Text`, so the body became the caption (rendered as
    // the indexed fallback "Tab 1") and `slice(1)` left the panel empty — a
    // `missing tab body` marker on every frontend, while the dropped literal
    // still shipped to translators as a live catalog key.  A `Tab` whose
    // positional 0 is a CALL now renders it as body; the unrecognised
    // `title:` remains an author error the IR gate should name
    // (`loom.page-primitive-unknown-arg`, see IMPL-NOTES.md).
    const labelIsTextLike = labelArg !== undefined && labelArg.kind !== "call";
    const bodyArgs = labelIsTextLike ? tabPositionals.slice(1) : tabPositionals;
    const isLiteralLabel = labelArg?.kind === "literal" && labelArg.lit === "string";
    const labelStr = isLiteralLabel ? labelArg.value : `Tab ${i + 1}`;
    const bodyParts = bodyArgs.map((e) => walk(e, ctx, depth + 2));
    return {
      // The switcher's anchor is derived from the SOURCE literal, never from the
      // translated caption — a `value:` that changed per locale would break
      // every selector, e2e spec and deep link the moment a translation landed.
      value: slugify(labelStr) || `tab-${i + 1}`,
      ...tabLabelForms(isLiteralLabel ? arg : undefined, ctx, labelStr),
      bodyJsx:
        bodyParts.length > 0 ? joinBody(bodyParts) : ctx.target.renderComment("missing tab body"),
      // The same children UNJOINED, for the two packs that emit a PROGRAMMING
      // LANGUAGE rather than markup: Feliz splices them into an offside-
      // sensitive `prop.children [ … ]` list (`;`-separated) and Flutter needs
      // ONE widget per `TabBarView` child, so several fold into a `Column`.
      // The walker's `\n`-joined `bodyJsx` is a syntax hazard in both.
      bodyChildren: bodyParts,
    };
  });
  // Record the first tab group's default so the shell can declare the
  // controlled tab state a v-model target (Vue) needs. Keep the first when a
  // page has several groups — they share the single `__loomTab` model.
  if (tabs.length > 0 && ctx.tabsDefault === undefined) {
    ctx.tabsDefault = tabs[0]?.value ?? "tab-1";
  }
  return renderPrimitive(ctx, "primitive-tabs", {
    tabs,
    hasTabs: tabs.length > 0,
    defaultValue: tabs[0]?.value ?? "",
    indent: "  ".repeat(depth + 1),
    innerIndent: "  ".repeat(depth + 2),
    closeIndent: "  ".repeat(depth),
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitToolbar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toolbar(...children) — same children-as-positionals contract
  // as Group, but with space-between justification (canonical
  // page-header layout: left-aligned + right-aligned cluster).
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-toolbar", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
    // role="toolbar" + accessible name (Toolbar a11y contract).  The name is
    // translated through `t()` on an i18n frontend (M-T1.11, `toolbarAria` slot),
    // static otherwise (byte-identical).  The default "Actions" has no source
    // literal → not in the catalog → always static.  The two frontends whose
    // markup is not HTML build a prop from `ariaLabelExpr` instead: the SAME
    // accessible name, already translated, as a target-native expression
    // (D-I18N-ATTR).
    a11yAttr: ` role="toolbar"${localizedAriaLabelAttr(call, ctx, "toolbarAria", "label", "Actions")}`,
    ariaLabelExpr: localizedNamedValue(call, ctx, "toolbarAria", "label", "Actions"),
  });
}

export function emitCard(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Card("title", ...children) — first positional title (anything not
  // a call counts as title); EVERY remaining positional is a body child.
  // `Card(child)` (single non-text-like positional)
  // renders a card with no heading.
  //
  // EVERY remaining positional is a body child, not `positionals[1]` alone:
  // Card is a container like `Stack`/`Section` and joins its children the same
  // way.  Taking only the first would drop the `Slot` from
  // `Card { "T", Text { … }, Slot { } }` without a word.
  const positionals = positionalArgs(call);
  const titleArg = positionals[0];
  const titleIsTextLike = titleArg !== undefined && titleArg.kind !== "call";
  const contentExprs: ExprIR[] = titleIsTextLike ? positionals.slice(1) : positionals;
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  // The card title is a user-visible text slot (positional 0, only when the
  // first arg is text-like rather than the body) — translate a plain literal
  // through `t()` under i18n; dynamic / non-i18n stays byte-identical.
  const titleText =
    titleIsTextLike && titleArg ? localizedText(call, ctx, "cardTitle", '""', 0) : undefined;
  // `Card` is a `nesting: true` container in the a11y contract — its body
  // `Heading`s derive one rank deeper (accessibility.md).  The card
  // title itself is not a `Heading` primitive, so it is unaffected.
  const contentParts = withHeadingNesting(ctx, () =>
    contentExprs.map((e) => walk(e, ctx, depth + 1)),
  );
  const contentJsx =
    contentParts.length > 0
      ? contentParts.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`)
      : undefined;
  // visual rank.  `variant: "raised" | "flat" | "outline"`
  // picks the card's elevation idiom per pack.  `shadow: "sm" | "md"
  // | "lg" | "none"` overrides the variant's default shadow level.
  const variant = stringNamed(call, "variant");
  const shadow = stringNamed(call, "shadow");
  return renderPrimitive(ctx, "primitive-card", {
    hasTitle: titleText !== undefined,
    titleText,
    hasContent: contentJsx !== undefined,
    contentJsx,
    // The same children UNJOINED, for the two packs that emit a programming
    // language rather than markup: Feliz splices them into one offside-
    // sensitive F# `prop.children [ … ]` list (`;`-separated, one line) and
    // Flutter into a Dart `<Widget>[ … ]` literal.  A `\n`-joined
    // `contentJsx` is a syntax hazard in both, so they join it themselves.
    contentChildren: contentParts,
    indent,
    closeIndent,
    variant,
    hasVariant: variant !== undefined,
    shadow,
    hasShadow: shadow !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
