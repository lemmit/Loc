// PROCEDURAL Feliz design pack (fable-elmish-frontend.md §4).
//
// The Handlebars pack format emits markup STRINGS; Feliz "markup" is F# code
// (`Html.div [ … ]`), so the spike chose procedural emission over templates.
// This is a `LoadedPack` whose `render(name, ctx)` dispatches to per-primitive
// F#-emitting functions instead of compiled templates.  A missing primitive
// returns a visible `(* … *)` comment.
//
// The design system is daisyUI (a Tailwind component layer — pure CSS classes,
// so Feliz just emits `prop.className "card"` etc.).  The classes here resolve
// against the `styles.css` / `tailwind.config.js` the project ships (see
// `index.ts`); daisyUI supplies `btn` / `card` / `table` / `badge` / `alert` /
// `collapse` / … + the theme.  This matches the in-repo HEEx daisyUI pack, so
// the aesthetic stays consistent across the Feliz and Phoenix frontends.

import { lowerFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";

type Ctx = Record<string, string | number | boolean | undefined>;

/** A walked branch that came back as the missing-arg sentinel `"null"` (JS)
 *  must become `Html.none` — F# has no bare `null` element. */
function asElement(s: string | undefined): string {
  const t = (s ?? "").trim();
  return t === "" || t === "null" ? "Html.none" : t;
}

/** Collapse a walked element to ONE line — needed for the QueryView branches
 *  that sit inline on the `View.remoteList` header line (a multi-line arg there
 *  would be offside).  Safe: Feliz emits block comments (`(* … *)`) only, and
 *  source newlines here are structural.  (The `data:` render body is exempt —
 *  it is the trailing lambda's bracket-delimited body, which may span lines.) */
function oneLineEl(s: string | undefined): string {
  return asElement(s)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** Wrap a walker-produced text field as a Feliz CHILD element.  The walker
 *  hands text as either a raw string literal (`Counter`) or an already-rendered
 *  interpolation (`Html.text (string …)`); a child slot needs `Html.text` for
 *  the former and the expression verbatim for the latter. */
function asChild(text: string | undefined): string {
  const s = (text ?? "").trim();
  if (s.startsWith("Html.") || s.startsWith("(")) return s;
  return `Html.text "${s}"`;
}

/** A flex-container primitive (Stack = vertical, Group = horizontal) with a
 *  daisyUI/Tailwind layout class.  Same offside-safe children handling either
 *  way — only the flex direction differs.  An empty container (e.g. a scaffold
 *  detail's operations area when the aggregate has no public operations) renders
 *  nothing — `Html.none`, not a dead empty `<div>`. */
function flexContainer(className: string, c: Ctx): string {
  if (!c.hasChildren) return "Html.none";
  // The walker joins children with `\n${indent}` — so the FIRST child carries
  // no leading indent while its siblings do.  F# lists are offside-sensitive:
  // every element must share a column, so prefix the first child with the same
  // `indent` the join used.  (Later multi-line children keep their own internal
  // indentation, which is already self-consistent.)  `className` + `children`
  // share the col-2 column, offside-consistent.
  const indent = String(c.indent ?? "  ");
  const children = `${indent}${String(c.childrenBlock ?? "")}`;
  return `Html.div [\n  prop.className "${className}";\n  prop.children [\n${children}\n  ]\n]`;
}

/** Stack — a vertical flow (daisyUI/Tailwind `flex flex-col gap-4`). */
function primitiveStack(c: Ctx): string {
  return flexContainer("flex flex-col gap-4", c);
}

/** Group — a horizontal row that wraps (`flex flex-row flex-wrap …`). */
function primitiveGroup(c: Ctx): string {
  return flexContainer("flex flex-row flex-wrap items-center gap-2", c);
}

/** A children-container primitive (Stack/Group/Paper/Toolbar/Breadcrumbs) with a
 *  CSS class.  Same offside-safe children handling as `primitiveStack` (multi-
 *  line element lists are fine inside `[ … ]`; only offside-keywords aren't). */
function containerEl(tag: string, className: string, c: Ctx): string {
  const cls = `prop.className "${className}"`;
  if (!c.hasChildren) return `Html.${tag} [ ${cls} ]`;
  const indent = String(c.indent ?? "  ");
  const children = `${indent}${String(c.childrenBlock ?? "")}`;
  // Keep the structural props (`className`, `children [`) on the OPENING line so
  // only the children span lines — a separate-line `prop.children` would sit at
  // the parent's child column and F# would parse it as a PARENT-list element.
  // Paren-wrap so a following sibling isn't absorbed as a curried arg (§24).
  return `(Html.${tag} [ ${cls}; prop.children [\n${children}\n  ] ])`;
}

/** Paper — a surface container (a bordered, padded daisyUI `rounded-box`). */
function primitivePaper(c: Ctx): string {
  return containerEl("div", "rounded-box border border-base-300 bg-base-100 p-4 shadow-sm", c);
}

/** Toolbar — a page-header row (space-between flex container). */
function primitiveToolbar(c: Ctx): string {
  return containerEl("div", "flex flex-row items-center justify-between gap-2 py-2", c);
}

/** Breadcrumbs — a nav trail (daisyUI `breadcrumbs`). */
function primitiveBreadcrumbs(c: Ctx): string {
  return containerEl("nav", "breadcrumbs text-sm", c);
}

/** daisyUI alert variant from a Loom `color:` (default `red` → `alert-error`). */
function alertVariant(color: string): string {
  switch (color) {
    case "yellow":
      return "alert-warning";
    case "green":
      return "alert-success";
    case "blue":
      return "alert-info";
    default:
      return "alert-error";
  }
}

/** Alert(message, color?, title?) — a daisyUI callout.  `message` arrives as raw
 *  (unwrapped, escaped) text; an optional bold title precedes it. */
function primitiveAlert(c: Ctx): string {
  const kids: string[] = [];
  if (c.hasTitle) kids.push(`Html.strong [ Html.text "${String(c.title ?? "")}" ]`);
  kids.push(asChild(String(c.message ?? "")));
  const variant = alertVariant(String(c.color ?? "red"));
  return `Html.div [ prop.className "alert ${variant}"; prop.role "alert"; prop.children [ ${kids.join("; ")} ] ]`;
}

/** Empty("No results") — a centred, muted empty-state placeholder. */
function primitiveEmpty(c: Ctx): string {
  return `Html.div [ prop.className "flex min-h-40 flex-col items-center justify-center gap-2 text-center text-base-content/70"; prop.children [ ${asChild(String(c.text ?? ""))} ] ]`;
}

/** Skeleton — a loading placeholder (daisyUI `skeleton`; count/height v1-fixed). */
function primitiveSkeleton(_c: Ctx): string {
  return `Html.div [ prop.className "skeleton h-24 w-full" ]`;
}

/** KeyValueRow(label, value) — a detail-page field row (label + value cell).
 *  `label` is raw text; `childJsx` is an already-walked value element. */
function primitiveKeyValueRow(c: Ctx): string {
  const label = `Html.dt [ prop.className "text-sm font-medium text-base-content/70 sm:w-40 sm:flex-shrink-0"; prop.text "${String(c.label ?? "")}" ]`;
  const value = `Html.dd [ prop.className "text-sm text-base-content"; prop.children [ ${asChild(String(c.childJsx ?? ""))} ] ]`;
  return `Html.div [ prop.className "flex flex-col gap-1 py-1 sm:flex-row sm:gap-4"; prop.children [ ${label}; ${value} ] ]`;
}

/** Anchor(label, to?) — a link.  With a `to:` route it hrefs the Feliz.Router
 *  hash path (`#/products`); without one it's a plain text span (breadcrumb
 *  leaf).  `to` is a JS expression (a quoted literal or a ref) — a literal
 *  folds into a static `"#/path"`, a ref concatenates at runtime. */
function primitiveAnchor(c: Ctx): string {
  const label = String(c.label ?? "");
  if (!c.hasTo) return `Html.span [ Html.text "${label}" ]`;
  const to = String(c.to ?? '"/"');
  const lit = to.match(/^"(.*)"$/);
  const href = lit ? `"#${lit[1]}"` : `("#" + ${to})`;
  return `Html.a [ prop.className "link link-primary"; prop.href ${href}; prop.text "${label}" ]`;
}

/** Table(rows:, ...Column(header, accessor)) — the list-page data table.  Rows
 *  iterate `rowsExpr` via a `yield! … |> List.map` (offside-safe inside the
 *  `[ … ]` children list); each column is a header cell + a per-row value cell
 *  (the accessor already walked against the row var). */
function primitiveTable(c: Ctx): string {
  const cols = (c.columns as unknown as { header: string; cellJsx: string }[] | undefined) ?? [];
  const rowsExpr = String(c.rowsExpr ?? "[]");
  const rowVar = String(c.rowVar ?? "row");
  const headCells = cols.map((col) => `Html.th [ Html.text "${col.header}" ]`).join("; ");
  const bodyCells = cols
    .map((col) => `Html.td [ prop.children [ ${asChild(col.cellJsx)} ] ]`)
    .join("; ");
  const head = `Html.thead [ prop.children [ Html.tr [ prop.children [ ${headCells} ] ] ] ]`;
  // The `yield!` + its bracket-delimited body are offside-safe inside the
  // enclosing `prop.children [ … ]`.
  const body =
    `Html.tbody [ prop.children [\n` +
    `      yield! ${rowsExpr} |> List.map (fun ${rowVar} ->\n` +
    `        Html.tr [ prop.children [ ${bodyCells} ] ])\n` +
    `    ] ]`;
  // daisyUI `table table-zebra`, wrapped in a bordered, horizontally-scrollable
  // surface so wide tables stay contained.  Paren-wrapped against sibling
  // absorption (§24) since the wrapper is now the returned element.
  const table = `Html.table [ prop.className "table table-zebra w-full"; prop.children [ ${head}; ${body} ] ]`;
  return `(Html.div [ prop.className "overflow-x-auto rounded-box border border-base-300"; prop.children [ ${table} ] ])`;
}

/** IdLink — a table-cell link from a row id to its detail page.  Hrefs the
 *  Feliz.Router hash path (`#/products/<id>`); the id is the visible label. */
function primitiveIdLink(c: Ctx): string {
  const idExpr = String(c.idExpr ?? '""');
  const prefix = String(c.pathPrefix ?? "/");
  return `Html.a [ prop.className "link link-primary"; prop.href ("#${prefix}" + ${idExpr}); prop.text (string (${idExpr})) ]`;
}

/** Modal(trigger, form) — SUPERSEDED for Feliz by `felizTarget.renderModal`
 *  (which forks the whole primitive to a native `<details>` disclosure wrapping
 *  the operation form).  This pack entry is a fallback the fork bypasses; it
 *  renders just the labelled trigger. */
function primitiveModal(c: Ctx): string {
  const label = String(c.label ?? "Action");
  return `Html.button [ prop.className "btn btn-sm"; prop.text "${label}" ]`;
}

/** Heading — an `<hN>` whose weight/size scales with the level (daisyUI/Tailwind
 *  type ramp: h1 the page title, tapering to a plain bold sub-heading). */
function primitiveHeading(c: Ctx): string {
  const level = Number(c.level ?? 2);
  const tag = level >= 1 && level <= 6 ? `h${level}` : "h2";
  const cls =
    level <= 1
      ? "text-3xl font-bold"
      : level === 2
        ? "text-2xl font-semibold"
        : level === 3
          ? "text-xl font-semibold"
          : "text-lg font-semibold";
  return `Html.${tag} [ prop.className "${cls}"; prop.children [ ${asChild(String(c.text ?? ""))} ] ]`;
}

function primitiveText(c: Ctx): string {
  return `Html.p [ ${asChild(String(c.text ?? ""))} ]`;
}

function primitiveCard(c: Ctx): string {
  // Card("title", content) — a daisyUI card: an optional `card-title` heading +
  // a single content element, both inside the `card-body`.
  const kids: string[] = [];
  if (c.hasTitle)
    kids.push(
      `Html.h3 [ prop.className "card-title"; prop.children [ ${asChild(String(c.titleText ?? ""))} ] ]`,
    );
  if (c.hasContent) kids.push(String(c.contentJsx ?? ""));
  const body =
    kids.length > 0
      ? `; prop.children [ Html.div [ prop.className "card-body"; prop.children [ ${kids.join("; ")} ] ] ]`
      : "";
  return `Html.div [ prop.className "card bg-base-100 shadow"${body} ]`;
}

function primitiveBadge(c: Ctx): string {
  const label = String(c.label ?? "").trim();
  const inner =
    label.startsWith("Html.") || label.startsWith("(")
      ? `prop.children [ ${label} ]`
      : `prop.text "${label}"`;
  return `Html.span [ prop.className "badge badge-neutral"; ${inner} ]`;
}

function primitiveDivider(_c: Ctx): string {
  return `Html.div [ prop.className "divider" ]`;
}

function primitiveButton(c: Ctx): string {
  // A Feliz element list is EITHER all children (ReactElement) OR all props
  // (IReactProperty) — never mixed.  A button carries an onClick prop, so the
  // label goes through a prop too: `prop.text` for a plain string, or
  // `prop.children [ … ]` when the label is an already-rendered element.  The
  // daisyUI `btn btn-primary` class makes it a real design-system button.
  const props: string[] = [`prop.className "btn btn-primary"`];
  if (c.hasOnClick) props.push(`prop.onClick (${c.onClick})`);
  const label = String(c.label ?? "").trim();
  if (label.startsWith("Html.") || label.startsWith("(")) {
    props.push(`prop.children [ ${label} ]`);
  } else {
    props.push(`prop.text "${label}"`);
  }
  return `Html.button [ ${props.join("; ")} ]`;
}

// --- Prose / text-decoration primitives -----------------------------------
function primitiveBold(c: Ctx): string {
  return `Html.strong [ ${asChild(String(c.text ?? ""))} ]`;
}
function primitiveItalic(c: Ctx): string {
  return `Html.em [ ${asChild(String(c.text ?? ""))} ]`;
}
function primitiveInlineCode(c: Ctx): string {
  return `Html.code [ prop.className "rounded bg-base-200 px-1 text-sm"; prop.children [ ${asChild(String(c.text ?? ""))} ] ]`;
}
/** CodeBlock(source, language?, title?) — a `<pre><code>` block.  The F# string
 *  literal can't span lines, so real newlines in the source escape to `\n`. */
function primitiveCodeBlock(c: Ctx): string {
  const source = String(c.source ?? "").replace(/\n/g, "\\n");
  const pre = `Html.pre [ prop.className "overflow-x-auto rounded-md border border-base-300 bg-base-200 p-4 text-sm"; prop.children [ Html.code [ prop.text "${source}" ] ] ]`;
  if (!c.hasTitle) return pre;
  const title = `Html.div [ prop.className "border-b border-base-300 px-4 py-2 text-xs font-medium text-base-content/70"; prop.text "${String(c.title ?? "")}" ]`;
  return `Html.div [ prop.className "overflow-hidden rounded-md border border-base-300 bg-base-200"; prop.children [ ${title}; ${pre} ] ]`;
}

// --- Data-display primitives ----------------------------------------------
/** Money(value, currency?, decimals?) — a tabular-nums amount, currency-prefixed
 *  when given.  `valueExpr` is already an F# expression (a field read / literal);
 *  `string (…)` coerces whatever its type (decimal / int) to text. */
function primitiveMoney(c: Ctx): string {
  const amount = `string (${String(c.valueExpr ?? "0")})`;
  const text = c.hasCurrency ? `(${String(c.currency)} + " " + ${amount})` : `(${amount})`;
  return `Html.span [ prop.className "tabular-nums"; prop.text ${text} ]`;
}
function primitiveDateDisplay(c: Ctx): string {
  const value = String(c.valueExpr ?? '""');
  return `Html.time [ prop.className "whitespace-nowrap text-sm text-base-content/70"; prop.text (string (${value})) ]`;
}
function primitiveEnumBadge(c: Ctx): string {
  const value = String(c.valueExpr ?? '""');
  return `Html.span [ prop.className "badge badge-outline"; prop.text (string (${value})) ]`;
}
/** Stat(label, value) — a daisyUI stat card.  `label`/`value` are raw text. */
function primitiveStat(c: Ctx): string {
  const title = `Html.div [ prop.className "stat-title"; prop.children [ ${asChild(String(c.label ?? ""))} ] ]`;
  const val = `Html.div [ prop.className "stat-value tabular-nums"; prop.children [ ${asChild(String(c.value ?? ""))} ] ]`;
  return `Html.div [ prop.className "stats"; prop.children [ Html.div [ prop.className "stat"; prop.children [ ${title}; ${val} ] ] ] ]`;
}
/** Loader() — a centred daisyUI spinner (size v1-fixed). */
function primitiveLoader(_c: Ctx): string {
  return `Html.div [ prop.className "flex justify-center py-8"; prop.children [ Html.span [ prop.className "loading loading-spinner loading-lg text-primary" ] ] ]`;
}
/** Image(src, alt?) — a rounded `<img>`; `src`/`alt` are already-rendered exprs
 *  (a quoted literal or a ref).  A missing alt renders `alt=""` (the validator
 *  guarantees an explicit alt or `decorative`). */
function primitiveImage(c: Ctx): string {
  const src = String(c.src ?? '""');
  const alt = c.hasAlt ? String(c.alt) : '""';
  return `Html.img [ prop.className "rounded"; prop.src ${src}; prop.alt ${alt} ]`;
}
/** Avatar(src?, alt?) — a circle-cropped image, or a neutral placeholder circle. */
function primitiveAvatar(c: Ctx): string {
  if (!c.hasSrc) {
    return `Html.div [ prop.className "avatar placeholder"; prop.children [ Html.div [ prop.className "w-10 rounded-full bg-neutral text-neutral-content" ] ] ]`;
  }
  const alt = c.hasAlt ? String(c.alt) : '""';
  return `Html.div [ prop.className "avatar"; prop.children [ Html.div [ prop.className "w-10 rounded-full"; prop.children [ Html.img [ prop.src ${String(c.src)}; prop.alt ${alt} ] ] ] ] ]`;
}

// --- Layout containers (children-bearing) ---------------------------------
function primitiveGrid(c: Ctx): string {
  return containerEl("div", "grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3", c);
}
function primitiveContainer(c: Ctx): string {
  return containerEl("div", "mx-auto max-w-4xl px-4", c);
}
function primitiveSection(c: Ctx): string {
  return containerEl("section", "flex flex-col gap-4", c);
}
function primitiveSticky(c: Ctx): string {
  return containerEl("div", "sticky top-0 z-10", c);
}

/** QueryView — the MVU RemoteData match, rendered through the `View.remoteList`
 *  helper (emitted into App.fs by index.ts).  A helper CALL is offside-safe
 *  inside a Feliz children `[ … ]` list where a raw multi-line `match` is not:
 *  the four branches sit on the header line (parenthesised) and only the
 *  `data:` render lambda body spans lines, and that body is bracket-delimited
 *  markup.  `queryExpr` is the Model field (`AllOrders`); the arm binding the
 *  `data:` lambda param resolves to is its camelCase (`allOrders`), matching
 *  `felizTarget.renderQueryDataAccess`. */
function primitiveQueryView(c: Ctx): string {
  const field = String(c.queryExpr ?? "");
  const binding = lowerFirst(field);
  const loading = oneLineEl(c.loadingJsx as string);
  const error = oneLineEl(c.errorJsx as string);
  const empty = oneLineEl(c.emptyJsx as string);
  const data = asElement(c.dataJsx as string);
  // `single: true` (a byId detail read) matches a `Remote<'T option>` via
  // `View.remoteOne` (`Loaded (Some x) -> render x`); the default list read
  // matches `Remote<'T list>` via `View.remoteList`.  Wrap the whole call in
  // parens so it reads as ONE list element: when a QueryView has a sibling
  // AFTER it, the trailing multi-line lambda would otherwise let F# absorb the
  // next child as an extra curried argument.
  const helper = c.single ? "remoteOne" : "remoteList";
  return `(View.${helper} model.${field} (${loading}) (${error}) (${empty}) (fun ${binding} ->\n${data}))`;
}

const RENDERERS: Record<string, (c: Ctx) => string> = {
  "primitive-stack": primitiveStack,
  "primitive-query-view": primitiveQueryView,
  "primitive-group": primitiveGroup,
  "primitive-heading": primitiveHeading,
  "primitive-text": primitiveText,
  "primitive-button": primitiveButton,
  "primitive-card": primitiveCard,
  "primitive-badge": primitiveBadge,
  "primitive-divider": primitiveDivider,
  // Scaffold container/leaf primitives (List / New / Detail / Home pages).
  "primitive-paper": primitivePaper,
  "primitive-toolbar": primitiveToolbar,
  "primitive-breadcrumbs": primitiveBreadcrumbs,
  "primitive-alert": primitiveAlert,
  "primitive-empty": primitiveEmpty,
  "primitive-skeleton": primitiveSkeleton,
  "primitive-key-value-row": primitiveKeyValueRow,
  "primitive-anchor": primitiveAnchor,
  "primitive-table": primitiveTable,
  "primitive-id-link": primitiveIdLink,
  "primitive-modal": primitiveModal,
  // Prose / text-decoration.
  "primitive-bold": primitiveBold,
  "primitive-italic": primitiveItalic,
  "primitive-inline-code": primitiveInlineCode,
  "primitive-code-block": primitiveCodeBlock,
  // Data-display.
  "primitive-money": primitiveMoney,
  "primitive-date-display": primitiveDateDisplay,
  "primitive-enum-badge": primitiveEnumBadge,
  "primitive-stat": primitiveStat,
  "primitive-loader": primitiveLoader,
  "primitive-image": primitiveImage,
  "primitive-avatar": primitiveAvatar,
  // Layout containers.
  "primitive-grid": primitiveGrid,
  "primitive-container": primitiveContainer,
  "primitive-section": primitiveSection,
  "primitive-sticky": primitiveSticky,
};

/** Build the procedural Feliz pack.  Implements the `LoadedPack` render
 *  contract without Handlebars — the loader's template path is unused here. */
export function felizPack(): LoadedPack {
  return {
    manifest: { name: "felizBasic", version: "v1", format: "tsx", emits: {}, imports: {} },
    rootDir: "<feliz-procedural>",
    templates: new Map(),
    render(name: string, context: unknown): string {
      const fn = RENDERERS[name];
      if (!fn) return `(* feliz pack: no renderer for "${name}" *)`;
      return fn((context ?? {}) as Ctx);
    },
  };
}
