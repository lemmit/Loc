// Leaf display primitives: Stat, Badge, Slot, Divider, Breadcrumbs,
// Paper, Skeleton, Alert. Each renders through the active design pack
// and carries no child-scope creation of its own (Breadcrumbs/Paper
// recurse via the shared `positionalChildren`).

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  numericNamed,
  positionalArgs,
  stringNamed,
  unwrapAsAttr,
  unwrapTextLiteral,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import {
  firstPositionalContent,
  positionalChildren,
  renderTextContent,
  styleAttr,
  testidAttr,
} from "../walker-core.js";

export function emitStat(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Stat(label, value) — small headline-stat card.  No dedicated
  // component on either pack; both compose two stacked text
  // elements (dimmed label + bold value).
  const positionals = positionalArgs(call);
  const labelArg = positionals[0];
  const valueArg = positionals[1];
  const label = labelArg ? (renderTextContent(labelArg, ctx) ?? '""') : '""';
  const value = valueArg ? (renderTextContent(valueArg, ctx) ?? '""') : '""';
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-stat", {
    label: unwrapTextLiteral(label, ctx.target.escapeText),
    value: unwrapTextLiteral(value, ctx.target.escapeText),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitBadge(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const raw = firstPositionalContent(call, ctx) ?? '"Badge"';
  void depth;
  return renderPrimitive(ctx, "primitive-badge", {
    // `label` is JSX-children-friendly text — quotes stripped from
    // literals (Mantine / shadcn / chakra render `<Badge>X</Badge>`).
    // `labelAttr` is the JSX-attribute form — quotes preserved on
    // literals, JS expressions left as-is (MUI's `<Chip label=…/>`
    // needs either `label="X"` or `label={expr}`).
    label: unwrapTextLiteral(raw, ctx.target.escapeText),
    labelAttr: unwrapAsAttr(raw),
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitSlot(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Children-prop placeholder.  `Slot()` inside a
  // component's body renders whatever markup the parent passed in.
  // Marks usesChildren on the context so the shell adds the typed
  // children prop.  Targets whose slot spelling diverges from the
  // JSX `{children}` idiom (Svelte 5's `{@render children?.()}`)
  // override via the optional `renderChildrenSlot` seam.
  void call;
  void depth;
  ctx.usesChildren = true;
  return ctx.target.renderChildrenSlot?.() ?? `{children}`;
}

export function emitDivider(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  // Optional `label:` named arg — packs that support a labelled
  // divider can use the slot; packs that don't drop it.
  const label = stringNamed(call, "label");
  return renderPrimitive(ctx, "primitive-divider", {
    label,
    hasLabel: label !== undefined,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** Breadcrumbs(...children, testid?).  Wraps a chain of
 *  positional children (Anchor / Text / arbitrary primitives) in
 *  the per-pack breadcrumbs container.  Mantine's `<Breadcrumbs>`
 *  inserts separators automatically; shadcn renders a flex row
 *  with hand-emitted separators (template responsibility). */
export function emitBreadcrumbs(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-breadcrumbs", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** Paper(...children, padding?, testid?).  Per-pack
 *  surface container with consistent padding + subtle shadow.
 *  Composable wrapper for tables, cards, alerts.  Defaults to
 *  `p="md"` (Mantine) / equivalent shadcn class set. */
export function emitPaper(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const padding = stringNamed(call, "padding");
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-paper", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`${ctx.target.interChildSeparator ?? ""}\n${indent}`),
    hasPadding: padding !== undefined,
    padding: padding !== undefined ? JSON.stringify(padding) : "",
    indent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** Skeleton(height?, count?, testid?).  Per-pack
 *  loading-placeholder block.  When `count:` > 1, emits a stacked
 *  group of `count` skeleton lines (matching the scaffold's
 *  loading-state convention).  `height:` defaults to 28px. */
export function emitSkeleton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const height = numericNamed(call, "height") ?? 28;
  const count = numericNamed(call, "count") ?? 1;
  return renderPrimitive(ctx, "primitive-skeleton", {
    height,
    count,
    isMulti: count > 1,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** Alert(message, color?, title?, testid?).  Per-pack
 *  callout for error / info / warning states.  `color:` accepts
 *  the per-pack semantic palette ("red"/"green"/"yellow"/"blue").
 *  `title:` is optional; without it, packs render the message
 *  alone (Mantine's `<Alert>` skips the bold-title block). */
export function emitAlert(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const message = firstPositionalContent(call, ctx) ?? '""';
  const color = stringNamed(call, "color");
  const title = stringNamed(call, "title");
  return renderPrimitive(ctx, "primitive-alert", {
    message: unwrapTextLiteral(message, ctx.target.escapeText),
    hasColor: color !== undefined,
    color: color ?? "red",
    hasTitle: title !== undefined,
    title: title ?? "",
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
