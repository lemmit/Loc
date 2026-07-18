// PROCEDURAL flutterMaterial design pack (flutter-mobile-implementation.md
// Track C — walking skeleton).
//
// Flutter is a Feliz clone: a non-JSX, function-call-tree target
// (`Column(children: [ … ])` ≈ Feliz's `Html.div [ prop.children [ … ] ]`).
// Like Feliz's daisyUI pack this is a PROCEDURAL `LoadedPack` — its
// `render(name, ctx)` dispatches to per-primitive Dart-emitting functions
// instead of compiled `.hbs` templates (a widget-tree language is a poor fit
// for markup-string templates).  A missing primitive returns a visible
// `// flutter pack: no renderer …` Dart comment.
//
// The design system is Material 3 (`package:flutter/material.dart`) — the
// renderers emit real Material widgets (`Card`, `ListView`, `AppBar`,
// `ElevatedButton`, `Text` with the ambient `Theme.of(context).textTheme`).
//
// SCOPE — WALKING SKELETON (display primitives only).  This pack renders the
// DISPLAY / layout primitives the List + Detail scaffold pages need.  The
// interactive / form family (`Field*` inputs, `Form`, `Modal`, `MasterDetail`,
// `Tabs`) is DEFERRED to full parity — see `TODO(flutter full-parity)` below —
// and is NOT part of the `flutter` required-primitive set (mirrors how the
// `angular` set drops the form/modal templates it renders inline).
//
// Child lists: the shared walker (`display.ts` / `layout.ts`) joins a
// container's children with `\n<indent>` and NO separator token — Feliz relies
// on F#'s offside newline-as-list-separator for this.  Dart list literals need
// commas, so the container renderers here emit a trailing comma after the child
// block; per-CHILD comma termination is supplied by the `flutterTarget` walker
// seam (Track B) at each child's emission site, the same division of labour as
// Feliz's offside handling.  Every renderer is null-safe under an empty context
// (the groundwork test renders each primitive with `{}`).

import { lowerFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";

type Ctx = Record<string, string | number | boolean | undefined>;

/** Prepare a string for a single-quoted Dart string literal body.
 *
 *  IDENTITY BY CONTRACT: every value the pack wraps in `Text('…')` is a walker
 *  Ctx field (`c.text`, `c.label`, `c.title`, `col.header`, …) that the shared
 *  walker ALREADY escaped through the `flutterTarget.escapeText` seam (see
 *  `_walker/primitives/*.ts` — `unwrapTextLiteral(x, ctx.target.escapeText)`).
 *  Re-escaping here would double every backslash/quote (`Today's` →
 *  `Today\\\'s`).  This matches the cross-framework contract: the walker escapes
 *  via the target seam, the pack inserts as-is (the mantine/vuetify packs never
 *  re-escape either).  Kept as a named seam so the intent is explicit at each
 *  wrap site. */
function dartStr(s: string): string {
  return s;
}

/** Apply a text style to a walked text value that may arrive EITHER as raw
 *  (walker-escaped) text OR as an already-built widget.  Flutter's
 *  `renderInterpolation` wraps a non-literal (e.g. `p.name`) into `Text('…')`,
 *  so a styled-text slot (`Heading`, `Card` title, `Stat`, …) can't blindly
 *  `Text('${value}', style: …)` — that would double-wrap into
 *  `Text('Text(…)', …)`.  If the value is already a widget, style it via
 *  `DefaultTextStyle.merge` (a bare descendant `Text` inherits the default);
 *  otherwise wrap the raw text directly. */
function styledText(value: string, styleExpr: string): string {
  const t = value.trim();
  if (/^[A-Za-z_][\w.]*\(/.test(t) || t.startsWith("(")) {
    return `DefaultTextStyle.merge(style: ${styleExpr}, child: ${t})`;
  }
  return `Text('${dartStr(t)}', style: ${styleExpr})`;
}

/** A walked branch that came back empty or as the missing-arg sentinel `"null"`
 *  must become an empty Flutter widget — Dart has no bare `null` child. */
function asWidget(s: string | undefined): string {
  const t = (s ?? "").trim();
  if (t === "" || t === "null") return "const SizedBox.shrink()";
  // Already a Dart widget/expression (a constructor call `Foo(…)`, a member
  // access, or a parenthesised expression) — pass through verbatim.  Otherwise
  // it is raw text the walker handed unquoted (a string literal): wrap it.
  if (/^[A-Za-z_][\w.]*\(/.test(t) || t.startsWith("(")) return t;
  return `Text('${dartStr(t)}')`;
}

/** Wrap a walker text field as a Flutter `Text` child.  Same raw-vs-expression
 *  discrimination as `asWidget`, but a bare interpolation expression is coerced
 *  to a string via `'$expr'` so it lands inside a `Text(…)`. */
function asText(s: string | undefined): string {
  const t = (s ?? "").trim();
  if (t === "") return "const SizedBox.shrink()";
  if (/^Text\(/.test(t) || t.startsWith("(")) return t;
  if (/^[A-Za-z_][\w.]*\(/.test(t)) return `Text('\${${t}}')`;
  return `Text('${dartStr(t)}')`;
}

/** Turn the walker's `testidAttr` context value into a Flutter
 *  `Key('data-testid=…')` (used by `flutter_test`/`WidgetTester` finders), or
 *  `""` when the primitive carried no `testid:`.  Static form arrives as the
 *  JSX fragment ` data-testid="orders-list"`; dynamic as a Dart expression from
 *  the target's `renderAttrBinding`.  Both fold to a `key:` argument fragment
 *  ready to splice into a widget's argument list (leading `key: `, no comma). */
function testidKey(c: Ctx): string {
  const raw = String(c.testidAttr ?? "").trim();
  if (raw === "") return "";
  const m = raw.match(/^data-testid=(.+)$/); // static ` data-testid="x"` (trimmed)
  if (m) {
    const lit = m[1].match(/^"(.*)"$/);
    return lit ? `key: const Key('${dartStr(lit[1])}')` : `key: Key(${m[1]})`;
  }
  return `key: Key(${raw})`;
}

/** Splice an argument fragment (e.g. a `testidKey`) into a widget arg list —
 *  returns `"<frag>, "` when present, `""` when empty. */
function arg(frag: string): string {
  return frag === "" ? "" : `${frag}, `;
}

/** A children-bearing container's `<Widget>[ <block>, ]`.  The trailing comma
 *  closes the last child (per-child commas come from the target — see the file
 *  header). */
function childrenList(c: Ctx): string {
  const indent = String(c.indent ?? "  ");
  const closeIndent = String(c.closeIndent ?? "");
  if (!c.hasChildren) return "const <Widget>[]";
  return `<Widget>[\n${indent}${String(c.childrenBlock ?? "")},\n${closeIndent}]`;
}

// --- Layout containers ------------------------------------------------------
/** Stack — a vertical flow (`Column`, start-aligned). */
function primitiveStack(c: Ctx): string {
  if (!c.hasChildren) return "const SizedBox.shrink()";
  return `Column(${arg(testidKey(c))}crossAxisAlignment: CrossAxisAlignment.start, children: ${childrenList(c)})`;
}

/** Group — a horizontal row that wraps (`Wrap`). */
function primitiveGroup(c: Ctx): string {
  if (!c.hasChildren) return "const SizedBox.shrink()";
  return `Wrap(${arg(testidKey(c))}spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: ${childrenList(c)})`;
}

/** Section — a semantic vertical group (`Column`). */
function primitiveSection(c: Ctx): string {
  if (!c.hasChildren) return "const SizedBox.shrink()";
  return `Column(${arg(testidKey(c))}crossAxisAlignment: CrossAxisAlignment.start, children: ${childrenList(c)})`;
}

/** Container — a centred, width-capped, padded box. */
function primitiveContainer(c: Ctx): string {
  const inner = c.hasChildren
    ? `Column(crossAxisAlignment: CrossAxisAlignment.start, children: ${childrenList(c)})`
    : "const SizedBox.shrink()";
  return `Container(${arg(testidKey(c))}constraints: const BoxConstraints(maxWidth: 896), padding: const EdgeInsets.symmetric(horizontal: 16), child: ${inner})`;
}

/** Grid — a responsive tile grid (`Wrap` of cells; a real `GridView.count`
 *  needs a bounded height, so `Wrap` is the skeleton form). */
function primitiveGrid(c: Ctx): string {
  if (!c.hasChildren) return "const SizedBox.shrink()";
  return `Wrap(${arg(testidKey(c))}spacing: 16, runSpacing: 16, children: ${childrenList(c)})`;
}

/** Sticky — a `position: sticky` wrapper.  Flutter has no direct analogue in a
 *  plain scroll view; the skeleton renders the child inline. */
function primitiveSticky(c: Ctx): string {
  return c.hasChildren
    ? `Column(crossAxisAlignment: CrossAxisAlignment.start, children: ${childrenList(c)})`
    : "const SizedBox.shrink()";
}

/** Paper — a surface container (an elevated, padded `Card`). */
function primitivePaper(c: Ctx): string {
  const inner = c.hasChildren
    ? `Column(crossAxisAlignment: CrossAxisAlignment.start, children: ${childrenList(c)})`
    : "const SizedBox.shrink()";
  return `Card(${arg(testidKey(c))}child: Padding(padding: const EdgeInsets.all(16), child: ${inner}))`;
}

/** Toolbar — a page-header row (space-between). */
function primitiveToolbar(c: Ctx): string {
  if (!c.hasChildren) return "const SizedBox.shrink()";
  return `Row(${arg(testidKey(c))}mainAxisAlignment: MainAxisAlignment.spaceBetween, crossAxisAlignment: CrossAxisAlignment.center, children: ${childrenList(c)})`;
}

/** Breadcrumbs — a nav trail (a horizontal `Wrap` of links/text). */
function primitiveBreadcrumbs(c: Ctx): string {
  if (!c.hasChildren) return "const SizedBox.shrink()";
  return `Wrap(${arg(testidKey(c))}spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: ${childrenList(c)})`;
}

// --- Headings / prose -------------------------------------------------------
/** Heading — a `Text` scaled through the Material text theme by level. */
function primitiveHeading(c: Ctx): string {
  const level = Number(c.level ?? 2);
  const style =
    level <= 1
      ? "headlineMedium"
      : level === 2
        ? "titleLarge"
        : level === 3
          ? "titleMedium"
          : "titleSmall";
  const text = String(c.text ?? "").trim();
  return styledText(text, `Theme.of(context).textTheme.${style}`);
}

function primitiveText(c: Ctx): string {
  return asText(String(c.text ?? ""));
}

function primitiveBold(c: Ctx): string {
  return styledText(String(c.text ?? ""), "const TextStyle(fontWeight: FontWeight.bold)");
}
function primitiveItalic(c: Ctx): string {
  return styledText(String(c.text ?? ""), "const TextStyle(fontStyle: FontStyle.italic)");
}
function primitiveInlineCode(c: Ctx): string {
  return styledText(String(c.text ?? ""), "const TextStyle(fontFamily: 'monospace')");
}
/** CodeBlock(source, language?, title?) — a monospace block in a tonal card. */
function primitiveCodeBlock(c: Ctx): string {
  const source = String(c.source ?? "");
  const pre = `Container(width: double.infinity, padding: const EdgeInsets.all(16), color: Theme.of(context).colorScheme.surfaceContainerHighest, child: Text('${dartStr(source)}', style: const TextStyle(fontFamily: 'monospace', fontSize: 13)))`;
  if (!c.hasTitle) return pre;
  const title = `Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8), child: ${styledText(String(c.title ?? ""), "Theme.of(context).textTheme.labelMedium")})`;
  return `Card(clipBehavior: Clip.antiAlias, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[${title}, ${pre}]))`;
}

// --- Cards / callouts -------------------------------------------------------
function primitiveCard(c: Ctx): string {
  const kids: string[] = [];
  if (c.hasTitle)
    kids.push(styledText(String(c.titleText ?? ""), "Theme.of(context).textTheme.titleMedium"));
  if (c.hasContent) kids.push(asWidget(String(c.contentJsx ?? "")));
  const body =
    kids.length > 0
      ? `Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[${kids.join(", ")}])`
      : "const SizedBox.shrink()";
  return `Card(${arg(testidKey(c))}child: Padding(padding: const EdgeInsets.all(16), child: ${body}))`;
}

function primitiveBadge(c: Ctx): string {
  const label = String(c.label ?? "").trim();
  return `Chip(label: ${asText(label)}, visualDensity: VisualDensity.compact)`;
}

function primitiveDivider(_c: Ctx): string {
  return "const Divider()";
}

/** A daisyUI-style `color:` → a Material colour for alert callouts. */
function alertColor(color: string): string {
  switch (color) {
    case "yellow":
      return "Colors.orange";
    case "green":
      return "Colors.green";
    case "blue":
      return "Colors.blue";
    default:
      return "Theme.of(context).colorScheme.error";
  }
}

/** Alert(message, color?, title?) — a tinted, bordered callout container. */
function primitiveAlert(c: Ctx): string {
  const kids: string[] = [];
  if (c.hasTitle)
    kids.push(styledText(String(c.title ?? ""), "const TextStyle(fontWeight: FontWeight.bold)"));
  kids.push(asText(String(c.message ?? "")));
  const color = alertColor(String(c.color ?? "red"));
  return `Container(width: double.infinity, padding: const EdgeInsets.all(12), decoration: BoxDecoration(border: Border.all(color: ${color}), borderRadius: BorderRadius.circular(8)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[${kids.join(", ")}]))`;
}

/** Empty("No results") — a centred, muted empty-state placeholder. */
function primitiveEmpty(c: Ctx): string {
  return `Center(child: Padding(padding: const EdgeInsets.all(32), child: ${asText(String(c.text ?? ""))}))`;
}

/** Skeleton — a loading placeholder block. */
function primitiveSkeleton(_c: Ctx): string {
  return "Container(height: 96, decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)))";
}

/** Loader() — a centred Material spinner. */
function primitiveLoader(_c: Ctx): string {
  return "const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))";
}

// --- Data-display -----------------------------------------------------------
/** KeyValueRow(label, value) — a detail-page field row. */
function primitiveKeyValueRow(c: Ctx): string {
  const label = `SizedBox(width: 160, child: Text('${dartStr(String(c.label ?? ""))}', style: Theme.of(context).textTheme.bodySmall))`;
  const value = `Expanded(child: DefaultTextStyle.merge(child: ${asWidget(String(c.childJsx ?? ""))}, style: Theme.of(context).textTheme.bodyMedium))`;
  return `Padding(${arg(testidKey(c))}padding: const EdgeInsets.symmetric(vertical: 4), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[${label}, ${value}]))`;
}

/** Anchor(label, to?) — a navigation link (or plain text when `to:` is absent). */
function primitiveAnchor(c: Ctx): string {
  const label = String(c.label ?? "");
  if (!c.hasTo) return `Text('${dartStr(label)}')`;
  const to = String(c.to ?? '"/"');
  const lit = to.match(/^"(.*)"$/);
  const route = lit ? `'${dartStr(lit[1])}'` : to;
  return `TextButton(onPressed: () => Navigator.of(context).pushNamed(${route}), child: Text('${dartStr(label)}'))`;
}

/** IdLink — a table-cell link from a row id to its detail route. */
function primitiveIdLink(c: Ctx): string {
  const idExpr = String(c.idExpr ?? "''");
  const prefix = String(c.pathPrefix ?? "/");
  return `TextButton(onPressed: () => Navigator.of(context).pushNamed('${dartStr(prefix)}' + ${idExpr}.toString()), child: Text(${idExpr}.toString()))`;
}

/** Money(value, currency?, decimals?) — a currency-prefixed amount. */
function primitiveMoney(c: Ctx): string {
  const amount = `${String(c.valueExpr ?? "0")}.toString()`;
  const text = c.hasCurrency ? `'\${${String(c.currency)}} ' + ${amount}` : amount;
  return `Text(${text}, style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]))`;
}

function primitiveDateDisplay(c: Ctx): string {
  const value = String(c.valueExpr ?? "''");
  return `Text(${value}.toString(), style: Theme.of(context).textTheme.bodySmall)`;
}

function primitiveEnumBadge(c: Ctx): string {
  const value = String(c.valueExpr ?? "''");
  return `Chip(label: Text(${value}.toString()), visualDensity: VisualDensity.compact)`;
}

/** Stat(label, value) — a labelled metric block. */
function primitiveStat(c: Ctx): string {
  const label = styledText(String(c.label ?? ""), "Theme.of(context).textTheme.bodySmall");
  const value = styledText(String(c.value ?? ""), "Theme.of(context).textTheme.headlineSmall");
  return `Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[${label}, ${value}])`;
}

/** Image(src, alt?) — a network image (`alt` maps to `semanticLabel`). */
function primitiveImage(c: Ctx): string {
  const src = String(c.src ?? "''");
  const alt = c.hasAlt ? `, semanticLabel: ${String(c.alt)}` : "";
  return `Image.network(${src}${alt})`;
}

/** Avatar(src?, alt?) — a circle image or a neutral placeholder circle. */
function primitiveAvatar(c: Ctx): string {
  if (!c.hasSrc) return "const CircleAvatar(radius: 20)";
  return `CircleAvatar(radius: 20, backgroundImage: NetworkImage(${String(c.src)}))`;
}

/** Icon(name|svg, size?, label?) — a Material icon placeholder.  The DSL icon
 *  registry hands an SVG string; Flutter icons come from a font, so the skeleton
 *  renders a generic glyph sized by `size:`.  TODO(flutter full-parity): map
 *  the icon name to `Icons.*` / bundle the SVG asset. */
function primitiveIcon(c: Ctx): string {
  const size =
    c.size === "sm" ? "16.0" : c.size === "lg" ? "24.0" : c.size === "xl" ? "32.0" : "20.0";
  const label = String(c.label ?? "").trim();
  const decorative = c.decorative === true || String(c.decorative) === "true";
  const semantics = label !== "" && !decorative ? `, semanticLabel: '${dartStr(label)}'` : "";
  return `Icon(Icons.circle, size: ${size}${semantics})`;
}

// --- Table (list-page data grid) -------------------------------------------
/** Table(rows:, ...Column(header, accessor)) — the list-page data table,
 *  rendered as a horizontally-scrollable `DataTable` whose rows map the
 *  `rowsExpr` collection under `rowVar`. */
function primitiveTable(c: Ctx): string {
  const cols = (c.columns as unknown as { header: string; cellJsx: string }[] | undefined) ?? [];
  const rowsExpr = String(c.rowsExpr ?? "const []");
  const rowVar = String(c.rowVar ?? "row");
  const headCells = cols
    .map((col) => `DataColumn(label: Text('${dartStr(col.header)}'))`)
    .join(", ");
  const bodyCells = cols.map((col) => `DataCell(${asWidget(col.cellJsx)})`).join(", ");
  const rowTid = c.rowTestid ? `key: Key(${String(c.rowTestid)}), ` : "";
  const dataRow = `DataRow(${rowTid}cells: <DataCell>[${bodyCells}])`;
  const rows = `${rowsExpr}.map((${rowVar}) => ${dataRow}).toList()`;
  const table = `DataTable(columns: <DataColumn>[${headCells}], rows: ${rows})`;
  return `SingleChildScrollView(${arg(testidKey(c))}scrollDirection: Axis.horizontal, child: ${table})`;
}

// --- QueryView (RemoteData match) ------------------------------------------
/** A QueryView branch (loading / error / empty / data) is ALREADY a walked
 *  widget string — the shared walker rendered it through this same pack.  Only
 *  a missing branch (the walker's `"null"` sentinel / empty) needs the neutral
 *  empty widget; everything else passes through verbatim (unlike `asWidget`,
 *  which re-wraps a leading-`const` widget — `const Center(…)` — as text). */
function branchWidget(s: string | undefined): string {
  const t = (s ?? "").trim();
  return t === "" || t === "null" ? "const SizedBox.shrink()" : t;
}

/** QueryView — the async read match.  Dispatches on the hoisted `AsyncValue`
 *  (`ref.watch(<var>Provider)`, bound at the ConsumerWidget's build top) via
 *  Riverpod's `AsyncValue.when`: a `loading:` / `error:` / `data:` triad, with
 *  the `empty:` branch folded into `data:` (an empty `List<T>` — or a `null`
 *  byId record — routes to the empty widget).  The `data:` callback binds the
 *  loaded value under the query's camelCase name, so the walked `data:` body
 *  (whose lambda param the target rebinds to that name) reads it directly —
 *  mirroring Feliz's `| Loaded <binding> ->` arm. */
function primitiveQueryView(c: Ctx): string {
  const field = String(c.queryExpr ?? "");
  const binding = lowerFirst(field) || "value";
  const loading = branchWidget(c.loadingJsx as string);
  const error = branchWidget(c.errorJsx as string);
  const empty = branchWidget(c.emptyJsx as string);
  const data = branchWidget(c.dataJsx as string);
  // byId (single): the loaded value is `T?` — empty when `null`, else the
  // flow-promoted record.  List: empty when the `List<T>` is empty.
  const emptyGuard = c.single ? `${binding} == null` : `${binding}.isEmpty`;
  return `${field}.when(loading: () => ${loading}, error: (error, stack) => ${error}, data: (${binding}) => ${emptyGuard} ? ${empty} : ${data})`;
}

/** Button — an `ElevatedButton`; the walker hands the label as raw text or an
 *  already-rendered element, plus an optional `onClick`/`ariaLabel`.  A missing
 *  handler renders a disabled button (`onPressed: null`). */
function primitiveButton(c: Ctx): string {
  const label = String(c.label ?? "").trim();
  const child = asWidget(label);
  const onPressed = c.hasOnClick ? String(c.onClick) : "null";
  const ariaLabel = String(c.ariaLabel ?? "").trim();
  const btn = `ElevatedButton(${arg(testidKey(c))}onPressed: ${onPressed}, child: ${child})`;
  return ariaLabel !== "" ? `Semantics(label: '${dartStr(ariaLabel)}', child: ${btn})` : btn;
}

// ---------------------------------------------------------------------------
// TODO(flutter full-parity): the interactive / form family is NOT rendered in
// the walking skeleton and is deliberately absent from both `RENDERERS` and the
// `flutter` required-primitive set.  Full parity adds Dart renderers (or the
// `flutterTarget` inline seams) for: Field / MultilineField / PasswordField /
// NumberField / SelectField / Toggle (Material `TextFormField` /
// `DropdownButtonFormField` / `Switch`), Form / MasterDetail (a `Form` +
// two-pane layout), Modal (`showDialog`), and Tabs (`DefaultTabController` +
// `TabBar`/`TabBarView`).
// ---------------------------------------------------------------------------

const RENDERERS: Record<string, (c: Ctx) => string> = {
  // Layout containers.
  "primitive-stack": primitiveStack,
  "primitive-group": primitiveGroup,
  "primitive-section": primitiveSection,
  "primitive-container": primitiveContainer,
  "primitive-grid": primitiveGrid,
  "primitive-sticky": primitiveSticky,
  "primitive-paper": primitivePaper,
  "primitive-toolbar": primitiveToolbar,
  "primitive-breadcrumbs": primitiveBreadcrumbs,
  // Headings / prose.
  "primitive-heading": primitiveHeading,
  "primitive-text": primitiveText,
  "primitive-bold": primitiveBold,
  "primitive-italic": primitiveItalic,
  "primitive-inline-code": primitiveInlineCode,
  "primitive-code-block": primitiveCodeBlock,
  // Cards / callouts.
  "primitive-card": primitiveCard,
  "primitive-badge": primitiveBadge,
  "primitive-divider": primitiveDivider,
  "primitive-alert": primitiveAlert,
  "primitive-empty": primitiveEmpty,
  "primitive-skeleton": primitiveSkeleton,
  "primitive-loader": primitiveLoader,
  // Data-display.
  "primitive-key-value-row": primitiveKeyValueRow,
  "primitive-anchor": primitiveAnchor,
  "primitive-id-link": primitiveIdLink,
  "primitive-money": primitiveMoney,
  "primitive-date-display": primitiveDateDisplay,
  "primitive-enum-badge": primitiveEnumBadge,
  "primitive-stat": primitiveStat,
  "primitive-image": primitiveImage,
  "primitive-avatar": primitiveAvatar,
  "primitive-icon": primitiveIcon,
  // Table + async read.
  "primitive-table": primitiveTable,
  "primitive-query-view": primitiveQueryView,
  // Button — a List page's row actions + a Detail page's operation triggers
  // both dispatch it.
  "primitive-button": primitiveButton,
};

/** Build the procedural flutterMaterial pack.  Implements the `LoadedPack`
 *  render contract without Handlebars — the loader's template path is unused
 *  (the pack renders via `RENDERERS`, not compiled `.hbs`).  `templates` is
 *  empty: the only `.has()` capability probes in the walker
 *  (`primitive-modal-controlled`, `realtime-toast-setup`) are form-path probes,
 *  and the walking-skeleton pack deliberately ships no forms, so both correctly
 *  read as absent.  `manifest.format` is left unset — the `flutter` PackFormat
 *  is registered by the integrator (`src/util/builtin-formats.ts`), not here. */
export function flutterPack(): LoadedPack {
  return {
    manifest: {
      name: "flutterMaterial",
      version: "v1",
      emits: {},
      imports: {},
    },
    rootDir: "<flutter-procedural>",
    templates: new Map() as unknown as LoadedPack["templates"],
    render(name: string, context: unknown): string {
      const fn = RENDERERS[name];
      if (!fn) return `// flutter pack: no renderer for "${name}"`;
      return fn((context ?? {}) as Ctx);
    },
  };
}
