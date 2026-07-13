// Minimal PROCEDURAL Feliz design pack (fable-elmish-frontend.md §4).
//
// The Handlebars pack format emits markup STRINGS; Feliz "markup" is F# code
// (`Html.div [ … ]`), so the spike chose procedural emission over templates.
// This is a `LoadedPack` whose `render(name, ctx)` dispatches to per-primitive
// F#-emitting functions instead of compiled templates.  It starts with the
// handful of primitives the first example needs and grows example-by-example —
// NOT all ~80.  A missing primitive returns a visible `(* … *)` comment.

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

function primitiveStack(c: Ctx): string {
  if (!c.hasChildren) return "Html.div []";
  // The walker joins children with `\n${indent}` — so the FIRST child carries
  // no leading indent while its siblings do.  F# lists are offside-sensitive:
  // every element must share a column, so prefix the first child with the same
  // `indent` the join used.  (Later multi-line children keep their own internal
  // indentation, which is already self-consistent.)
  const indent = String(c.indent ?? "  ");
  const children = `${indent}${String(c.childrenBlock ?? "")}`;
  return `Html.div [\n  prop.children [\n${children}\n  ]\n]`;
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

/** Paper — a surface container (Stack-shaped, with a class). */
function primitivePaper(c: Ctx): string {
  return containerEl("div", "loom-paper", c);
}

/** Toolbar — a page-header row (space-between container). */
function primitiveToolbar(c: Ctx): string {
  return containerEl("div", "loom-toolbar", c);
}

/** Breadcrumbs — a nav trail container. */
function primitiveBreadcrumbs(c: Ctx): string {
  return containerEl("nav", "loom-breadcrumbs", c);
}

/** Alert(message, color?, title?) — an error/info callout.  `message` arrives
 *  as raw (unwrapped, escaped) text; an optional bold title precedes it. */
function primitiveAlert(c: Ctx): string {
  const kids: string[] = [];
  if (c.hasTitle) kids.push(`Html.strong [ Html.text "${String(c.title ?? "")}" ]`);
  kids.push(asChild(String(c.message ?? "")));
  return `Html.div [ prop.className "loom-alert"; prop.children [ ${kids.join("; ")} ] ]`;
}

/** Empty("No results") — a centred empty-state placeholder. */
function primitiveEmpty(c: Ctx): string {
  return `Html.div [ prop.className "loom-empty"; prop.children [ ${asChild(String(c.text ?? ""))} ] ]`;
}

/** Skeleton — a loading placeholder (a plain styled block; count/height ignored
 *  in v1). */
function primitiveSkeleton(_c: Ctx): string {
  return `Html.div [ prop.className "loom-skeleton" ]`;
}

/** KeyValueRow(label, value) — a detail-page field row (label + value cell).
 *  `label` is raw text; `childJsx` is an already-walked value element. */
function primitiveKeyValueRow(c: Ctx): string {
  const label = `Html.dt [ Html.text "${String(c.label ?? "")}" ]`;
  const value = `Html.dd [ prop.children [ ${asChild(String(c.childJsx ?? ""))} ] ]`;
  return `Html.div [ prop.className "loom-kv"; prop.children [ ${label}; ${value} ] ]`;
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
  return `Html.a [ prop.href ${href}; prop.text "${label}" ]`;
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
  return `Html.table [ prop.className "loom-table"; prop.children [ ${head}; ${body} ] ]`;
}

/** IdLink — a table-cell link from a row id to its detail page.  Hrefs the
 *  Feliz.Router hash path (`#/products/<id>`); the id is the visible label. */
function primitiveIdLink(c: Ctx): string {
  const idExpr = String(c.idExpr ?? '""');
  const prefix = String(c.pathPrefix ?? "/");
  return `Html.a [ prop.href ("#${prefix}" + ${idExpr}); prop.text (string (${idExpr})) ]`;
}

/** Modal(trigger, form) — the scaffold detail's action dialog.  v1 renders the
 *  trigger as a labelled button; the modal-wrapped operation's MVU wiring (open
 *  state + submit) is a follow-up, so the button is present but inert. */
function primitiveModal(c: Ctx): string {
  const label = String(c.label ?? "Action");
  return `Html.button [ prop.className "loom-modal-trigger"; prop.text "${label}" ]`;
}

function primitiveHeading(c: Ctx): string {
  const level = Number(c.level ?? 2);
  const tag = level >= 1 && level <= 6 ? `h${level}` : "h2";
  return `Html.${tag} [ ${asChild(String(c.text ?? ""))} ]`;
}

function primitiveText(c: Ctx): string {
  return `Html.p [ ${asChild(String(c.text ?? ""))} ]`;
}

function primitiveCard(c: Ctx): string {
  // Card("title", content) — an optional heading + a single content element.
  const kids: string[] = [];
  if (c.hasTitle) kids.push(`Html.h3 [ ${asChild(String(c.titleText ?? ""))} ]`);
  if (c.hasContent) kids.push(String(c.contentJsx ?? ""));
  const children = kids.length > 0 ? `; prop.children [ ${kids.join("; ")} ]` : "";
  return `Html.div [ prop.className "loom-card"${children} ]`;
}

function primitiveBadge(c: Ctx): string {
  const label = String(c.label ?? "").trim();
  const inner =
    label.startsWith("Html.") || label.startsWith("(")
      ? `prop.children [ ${label} ]`
      : `prop.text "${label}"`;
  return `Html.span [ prop.className "loom-badge"; ${inner} ]`;
}

function primitiveDivider(_c: Ctx): string {
  return "Html.hr []";
}

function primitiveButton(c: Ctx): string {
  // A Feliz element list is EITHER all children (ReactElement) OR all props
  // (IReactProperty) — never mixed.  A button carries an onClick prop, so the
  // label goes through a prop too: `prop.text` for a plain string, or
  // `prop.children [ … ]` when the label is an already-rendered element.
  const props: string[] = [];
  if (c.hasOnClick) props.push(`prop.onClick (${c.onClick})`);
  const label = String(c.label ?? "").trim();
  if (label.startsWith("Html.") || label.startsWith("(")) {
    props.push(`prop.children [ ${label} ]`);
  } else {
    props.push(`prop.text "${label}"`);
  }
  return `Html.button [ ${props.join("; ")} ]`;
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
  "primitive-group": primitiveStack,
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
