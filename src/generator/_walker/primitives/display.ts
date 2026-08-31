// Leaf display primitives: Stat, Badge, Slot, Divider, Breadcrumbs,
// Paper, Skeleton, Alert. Each renders through the active design pack
// and carries no child-scope creation of its own (Breadcrumbs/Paper
// recurse via the shared `positionalChildren`).

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { isWalkerPrimitive } from "../../../util/walker-primitive-names.js";
import {
  localizedNamedAttr,
  localizedNamedText,
  localizedRaw,
  localizedText,
} from "../i18n-emit.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  namedArgValue,
  numericNamed,
  positionalArgs,
  stringNamed,
  unwrapAsAttr,
  unwrapTextLiteral,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { positionalChildren, styleAttr, testidAttr, walk } from "../walker-core.js";

export function emitStat(call: ExprIR & { kind: "call" }, ctx: WalkContext, depth: number): string {
  // Stat(label, value) — small headline-stat card.  No dedicated
  // component on either pack; both compose two stacked text
  // elements (dimmed label + bold value).
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  // The VALUE slot may be a nested display primitive rather than a plain
  // expression — `Stat { "Revenue", Money { t.revenue } }`.  That matters
  // because some types cannot be rendered as a bare React child at all: a
  // `money` deserialises client-side to a decimal.js `Decimal`, which is a
  // `TS2322: Type 'Decimal' is not assignable to type 'ReactNode'` and would
  // crash at runtime — exactly why the scaffold's table-cell accessor wraps a
  // money column in `Money { … }`.  Routing it down the text path instead
  // coerces the nested call to nothing and renders the slot EMPTY, silently
  // dropping the only way to put a currency figure on a KPI card.
  const valueArg = positionalArgs(call)[1];
  const nestedValue =
    valueArg?.kind === "call" && isWalkerPrimitive(valueArg.name)
      ? walk(valueArg, ctx, depth + 1)
      : undefined;
  return renderPrimitive(ctx, "primitive-stat", {
    // `statLabel`/`statValue` are user-visible text slots — a plain literal is
    // translated through `t()` when the body opted into i18n, keyed to the
    // catalog; a dynamic slot / non-i18n target stays byte-identical.
    label: localizedText(call, ctx, "statLabel", '""', 0),
    value: nestedValue ?? localizedText(call, ctx, "statValue", '""', 1),
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
  // The badge label is a user-visible slot — translate a plain literal through
  // `t()` under i18n (both forms use the same call), else byte-identical.
  const raw = localizedRaw(call, ctx, "badge", '"Badge"');
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

/** The frameworks for which the `{children}` fallback below is the CORRECT
 *  spelling — i.e. the ones that embed JSX and take children as a prop.  React
 *  is the only one: Vue (`<slot />`), Svelte 5 (`{@render children?.()}`),
 *  Angular (`<ng-content>`), Feliz (`props.children`) and Flutter
 *  (`child ?? …`) each implement `renderChildrenSlot`.
 *
 *  It is an ALLOWLIST rather than a default because `{children}` is not inert
 *  where it is wrong — it is a valid-looking expression in F# (an anonymous
 *  record over an unbound name) and in Dart (a set literal), so a target that
 *  forgot the seam emitted code that read fine and did not compile.  A new
 *  frontend now fails loudly at its first `Slot { }` instead. */
const JSX_CHILDREN_PROP_FRAMEWORKS: ReadonlySet<string> = new Set(["react"]);

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
  const slot = ctx.target.renderChildrenSlot?.();
  if (slot !== undefined) return slot;
  if (!JSX_CHILDREN_PROP_FRAMEWORKS.has(ctx.target.framework)) {
    throw new Error(
      `walker: frontend '${ctx.target.framework}' has no renderChildrenSlot seam, but a component ` +
        "body renders `Slot { }`.  The JSX `{children}` fallback is a React idiom — implement " +
        "renderChildrenSlot (and have the component emitter declare the matching children " +
        "parameter) for this target.",
    );
  }
  return `{children}`;
}

export function emitDivider(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  // Optional `label:` named arg — packs that support a labelled divider can use
  // the slot; packs that don't drop it.  `hasLabel` gates the labelled branch
  // exactly as before (true only for a literal `label:` — a dynamic/absent label
  // is byte-identical to the pre-i18n path).  The label is user-visible text: a
  // plain literal translates through `t()` under i18n (keyed to the `dividerLabel`
  // catalog slot), else byte-identical.  `label` is the text-children form
  // (mui/vuetify/shadcn*/flowbite render the label as element text); `labelAttr`
  // is the complete bound-attribute fragment (mantine's `<Divider label=…>`).
  // Presence is the ARG, not a literal: testing for a literal reads a dynamic
  // `label: row.name` as "no label" and renders a bare rule, silently dropping
  // the author's text.  The label/labelAttr values below handle the dynamic
  // form.
  const hasLabel = namedArgValue(call, "label") !== undefined;
  return renderPrimitive(ctx, "primitive-divider", {
    label: localizedNamedText(call, ctx, "dividerLabel", "label", '""'),
    labelAttr: localizedNamedAttr(call, ctx, "dividerLabel", "label", "label"),
    hasLabel,
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
  const color = stringNamed(call, "color");
  // `hasTitle` gates the title block exactly as before — true only for a literal
  // `title:` (a dynamic/absent title is byte-identical to the pre-i18n path).
  // Presence is the ARG, not a literal — a dynamic `title:` still has text.
  const hasTitle = namedArgValue(call, "title") !== undefined;
  return renderPrimitive(ctx, "primitive-alert", {
    // Both the message and the `title` named slot are user-visible text: a plain
    // literal translates through `t()` under i18n (keyed to the catalog), else
    // byte-identical.  `title` is the text-children form (shadcn/chakra/mui/…),
    // `titleAttr` the complete bound-attribute fragment (Mantine/Vuetify).
    message: localizedText(call, ctx, "alert", '""'),
    hasColor: color !== undefined,
    color: color ?? "red",
    title: localizedNamedText(call, ctx, "alertTitle", "title", '""'),
    titleAttr: localizedNamedAttr(call, ctx, "alertTitle", "title", "title"),
    hasTitle,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}
