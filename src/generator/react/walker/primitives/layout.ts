// Layout / surface primitives: Stack, Group, Grid, Container, Tabs,
// Toolbar, Card. Each renders a per-pack container and recurses into
// positional children (Tabs into each Tab's body, Card into its body)
// via the shared walk helpers.

import type { ExprIR } from "../../../../ir/loom-ir.js";
import type { WalkContext } from "../../body-walker.js";
import {
  positionalChildren,
  renderTextContent,
  styleAttr,
  testidAttr,
  walk,
} from "../../body-walker.js";
import { renderPrimitive } from "../context.js";
import {
  escapeJsxText,
  positionalArgs,
  slugify,
  stringNamed,
  unwrapTextLiteral,
} from "../shared/args.js";

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

export function emitGrid(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Each child wraps in a per-pack column container (Mantine's
  // <Grid.Col span="auto">; shadcn's plain `<div>` since gap is
  // on the parent).  v0 gives every column equal weight; a future
  // change can read a `span:` named arg per child.
  const children = positionalChildren(call, ctx, depth + 2);
  const colIndent = "  ".repeat(depth + 1);
  const childIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-grid", {
    hasChildren: children.length > 0,
    children,
    colIndent,
    childIndent,
    closeIndent,
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
      label: escapeJsxText(labelStr),
      bodyJsx: bodyArg ? walk(bodyArg, ctx, depth + 2) : "{/* missing tab body */}",
    };
  });
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
      ? unwrapTextLiteral(renderTextContent(titleArg, ctx) ?? '""')
      : undefined;
  const contentJsx = contentExpr ? walk(contentExpr, ctx, depth + 1) : undefined;
  return renderPrimitive(ctx, "primitive-card", {
    hasTitle: titleText !== undefined,
    titleText,
    hasContent: contentJsx !== undefined,
    contentJsx,
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
