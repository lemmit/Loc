// Layout / surface primitives: Stack, Group, Grid, Container, Tabs,
// Toolbar, Card. Each renders a per-pack container and recurses into
// positional children (Tabs into each Tab's body, Card into its body)
// via the shared walk helpers.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { toolbarA11yAttr } from "../a11y-emit.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  namedArgValue,
  numericNamed,
  positionalArgs,
  slugify,
  stringNamed,
  unwrapTextLiteral,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import {
  positionalChildren,
  renderTextContent,
  styleAttr,
  testidAttr,
  walk,
} from "../walker-core.js";

/** Run `fn` with the walk one semantic heading-nesting level deeper — used
 *  by the `nesting: true` a11y-contract containers (`Section` / `Card`) so a
 *  `Heading` in their body derives a rank deeper (accessibility.md Phase 2).
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
    childrenBlock: children.join(`\n${indent}`),
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
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** Read the `cols:` named arg on a Grid call.
 *
 *  Accepts two forms:
 *    - Scalar int literal:  `cols: 3`  →  all three breakpoints use 3.
 *    - List literal:        `cols: [3, 2, 1]`  →  `[desktop, tablet, mobile]`.
 *
 *  When a breakpoint slot is missing in the list form, conservative
 *  defaults apply: `tablet = ceil(desktop/2)`, `mobile = 1`.  When the
 *  arg itself is absent, returns `undefined` and consumers fall back
 *  to their own non-responsive default. */
function gridColsArg(
  call: ExprIR & { kind: "call" },
): { desktop: number; tablet: number; mobile: number } | undefined {
  const scalar = numericNamed(call, "cols");
  if (scalar !== undefined) return { desktop: scalar, tablet: scalar, mobile: scalar };
  const raw = namedArgValue(call, "cols");
  if (raw?.kind !== "list") return undefined;
  const intElements: number[] = [];
  for (const el of raw.elements) {
    if (el.kind === "literal" && el.lit === "int") {
      const n = Number(el.value);
      if (Number.isFinite(n)) intElements.push(n);
    }
  }
  if (intElements.length === 0) return undefined;
  const desktop = intElements[0]!;
  const tablet = intElements[1] ?? Math.max(1, Math.ceil(desktop / 2));
  const mobile = intElements[2] ?? 1;
  return { desktop, tablet, mobile };
}

export function emitGrid(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Each child wraps in a per-pack column container (Mantine's
  // <Grid.Col span="auto">; shadcn's plain `<div>` since gap is
  // on the parent).  `cols:` (Phase 6) selects per-breakpoint column
  // counts; when absent, every child takes `span="auto"` and the
  // pack picks an equal-weight default.
  const children = positionalChildren(call, ctx, depth + 2);
  const colIndent = "  ".repeat(depth + 1);
  const childIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  const cols = gridColsArg(call);
  // Translate column counts to Mantine/MUI `span` values out of 12.
  // `floor(12 / N)` matches the on-screen ratios users intend; an N
  // greater than 12 clamps to 1 so the math stays sane.
  const spanFor = (n: number): number => Math.max(1, Math.floor(12 / Math.max(1, n)));
  return renderPrimitive(ctx, "primitive-grid", {
    hasChildren: children.length > 0,
    children,
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
  // children's `Heading`s derive one rank deeper (accessibility.md Phase 2).
  const children = withHeadingNesting(ctx, () => positionalChildren(call, ctx, depth + 1));
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-section", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
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
    childrenBlock: children.join(`\n${indent}`),
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
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    size,
    hasSize: size !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitTabs(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Tabs(Tab("Overview", body), Tab("Settings", body))
  // Each positional child must be a `Tab(label, body)` call;
  // anything else lands as a placeholder so the page still
  // compiles.  Tab labels must be string literals in v0; non-
  // literal labels fall back to indexed slugs `tab-1`, …
  const positionals = positionalArgs(call);
  const tabs = positionals.map((arg, i) => {
    if (arg.kind !== "call" || arg.name !== "Tab") {
      // Bare positional (e.g. `Tabs(Card(...), Card(...))`) — treat it as
      // the panel body directly with an auto-generated label.  Without
      // this fallback, the panel would emit a JSX comment as its only
      // child and tsc rejects it (Mantine's `TabsPanelProps` requires
      // a non-empty `children`).
      return {
        value: `tab-${i + 1}`,
        label: `Tab ${i + 1}`,
        bodyJsx: walk(arg, ctx, depth + 2),
      };
    }
    const tabPositionals = positionalArgs(arg);
    const labelArg = tabPositionals[0];
    const bodyArg = tabPositionals[1];
    const labelStr =
      labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
        ? labelArg.value
        : `Tab ${i + 1}`;
    return {
      value: slugify(labelStr) || `tab-${i + 1}`,
      label: ctx.target.escapeText(labelStr),
      bodyJsx: bodyArg
        ? walk(bodyArg, ctx, depth + 2)
        : ctx.target.renderComment("missing tab body"),
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
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
    // role="toolbar" + accessible name (Toolbar a11y contract).  HTML/markup
    // packs render the fragment; Feliz reads the raw `label` for its F# props.
    a11yAttr: toolbarA11yAttr({ label: stringNamed(call, "label") }),
    label: stringNamed(call, "label"),
  });
}

export function emitCard(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Card("title", content) — first positional title (anything not
  // a call counts as title); second positional is the body.
  // `Card(child)` (single non-text-like positional)
  // renders a card with no heading.
  const positionals = positionalArgs(call);
  const titleArg = positionals[0];
  const titleIsTextLike = titleArg !== undefined && titleArg.kind !== "call";
  const contentExpr: ExprIR | undefined = titleIsTextLike ? positionals[1] : positionals[0];
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const titleText =
    titleIsTextLike && titleArg
      ? unwrapTextLiteral(renderTextContent(titleArg, ctx) ?? '""', ctx.target.escapeText)
      : undefined;
  // `Card` is a `nesting: true` container in the a11y contract — its body
  // `Heading`s derive one rank deeper (accessibility.md Phase 2).  The card
  // title itself is not a `Heading` primitive, so it is unaffected.
  const contentJsx = contentExpr
    ? withHeadingNesting(ctx, () => walk(contentExpr, ctx, depth + 1))
    : undefined;
  // Phase 5 — visual rank.  `variant: "raised" | "flat" | "outline"`
  // picks the card's elevation idiom per pack.  `shadow: "sm" | "md"
  // | "lg" | "none"` overrides the variant's default shadow level.
  const variant = stringNamed(call, "variant");
  const shadow = stringNamed(call, "shadow");
  return renderPrimitive(ctx, "primitive-card", {
    hasTitle: titleText !== undefined,
    titleText,
    hasContent: contentJsx !== undefined,
    contentJsx,
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
