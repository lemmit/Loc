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

import { lowerFirst, upperFirst } from "../../util/naming.js";
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
  if (isRenderedElement(s)) return s;
  return `Html.text "${s}"`;
}

/** True when a walker-produced text field came back as an already-rendered
 *  ELEMENT rather than raw text — an interpolation (`Html.text (string …)`) or
 *  a parenthesised expression.  Under i18n (M-T1.11) every user-visible literal
 *  slot arrives in this form (`Html.text (I18n.t "<key>" "<default>")`), so a
 *  slot that splices its value into an F# string literal must branch here or it
 *  emits the whole call as visible text. */
function isRenderedElement(s: string): boolean {
  return s.startsWith("Html.") || s.startsWith("(");
}

/** A Feliz PROP for a text slot: `prop.text "…"` for raw text (byte-identical
 *  to the pre-i18n emission), `prop.children [ … ]` for an already-rendered
 *  element — `prop.text` takes a `string`, so an element cannot ride it. */
function textOrChildren(text: string | undefined): string {
  const s = (text ?? "").trim();
  return isRenderedElement(s) ? `prop.children [ ${s} ]` : `prop.text "${s}"`;
}

/** Turn the walker's `testidAttr` context value into a Feliz `prop.custom(…)`
 *  prop-list element, or `""` when the primitive carried no `testid:`.  The
 *  shared walker (`testidAttr` in walker-core) hands a STATIC testid as the
 *  JSX-shaped fragment ` data-testid="orders-list"` and a DYNAMIC one already as
 *  the Feliz prop `prop.custom("data-testid", …)` (via the target's
 *  `renderAttrBinding`).  JSX targets splice the string into a tag; Feliz needs
 *  a prop-list element, so unwrap the static form to `prop.custom(...)` and pass
 *  the dynamic form through unchanged.  This is the whole reason the pack picked
 *  up no testids before — the JSX fragment is meaningless inside `[ prop… ]`. */
function testidProp(c: Ctx): string {
  const raw = String(c.testidAttr ?? "").trim();
  if (raw === "") return "";
  if (raw.startsWith("prop.")) return raw; // dynamic — already an F# prop
  const m = raw.match(/^data-testid=(.+)$/); // static ` data-testid="x"` (trimmed)
  return m ? `prop.custom("data-testid", ${m[1]})` : "";
}

/** The accessible name a primitive carries, as an F# EXPRESSION ready for
 *  `prop.ariaLabel` — or `undefined` when the primitive has no name at all.
 *
 *  Feliz's markup is not HTML, so it cannot splice the walker's ` aria-label="…"`
 *  fragment; the walker hands it the same name as a target-native VALUE instead
 *  (`ariaLabelExpr`, D-I18N-ATTR in `_walker/i18n-emit.ts`).  That value is
 *  ALREADY translated where the ui has strings — `(I18n.t "<key>" "<default>")`,
 *  keyed to `.loom/messages.en.json` — and a plain F# `"…"` literal otherwise,
 *  which is byte-identical to the pre-i18n emission.  Before this seam the pack
 *  read the RAW `label:` text, which is why a Feliz Button/Toolbar shipped its
 *  accessible name in English no matter the locale.
 *
 *  `fallback` is the pack's own default for a primitive whose contract requires
 *  a name (Toolbar's `"Actions"`); it is already an F# literal. */
function ariaLabelExpr(c: Ctx, fallback: string): string;
function ariaLabelExpr(c: Ctx): string | undefined;
function ariaLabelExpr(c: Ctx, fallback?: string): string | undefined {
  const expr = String(c.ariaLabelExpr ?? "").trim();
  return expr !== "" ? expr : fallback;
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
  const tid = testidProp(c);
  const tidLine = tid ? `\n  ${tid};` : "";
  return `Html.div [\n  prop.className "${className}";${tidLine}\n  prop.children [\n${children}\n  ]\n]`;
}

/** Stack — a vertical flow (daisyUI/Tailwind `flex flex-col gap-4`). */
function primitiveStack(c: Ctx): string {
  return flexContainer("flex flex-col gap-4", c);
}

/** Group — a horizontal row that wraps (`flex flex-row flex-wrap …`).
 *  Uses the offside/curry-safe `containerEl` form (structural props on the
 *  opening line + paren-wrap), NOT the bare `flexContainer`: a Group nested
 *  INLINE inside another element's `prop.children [ … ]` — e.g. a scaffolded
 *  `KeyValueRow` value cell, where a `provenanced` field pairs its value with a
 *  `ProvenanceInfo` disclosure (`Group(Text(...), ProvenanceInfo(...))`) — is
 *  otherwise rejected by Fable ("This value is not a function and cannot be
 *  applied", the §24 curry).  An empty Group stays `Html.none` (the
 *  flex-container convention — e.g. `scaffoldOperations` emits `Group()` when an
 *  aggregate has no public operations). */
function primitiveGroup(c: Ctx): string {
  if (!c.hasChildren) return "Html.none";
  return containerEl("div", "flex flex-row flex-wrap items-center gap-2", c);
}

/** A children-container primitive (Stack/Group/Paper/Toolbar/Breadcrumbs) with a
 *  CSS class.  Same offside-safe children handling as `primitiveStack` (multi-
 *  line element lists are fine inside `[ … ]`; only offside-keywords aren't). */
function containerEl(tag: string, className: string, c: Ctx, extraProps = ""): string {
  // `extraProps` — additional leaf props (e.g. a11y `prop.role`/`prop.ariaLabel`)
  // spliced after `className` (and any `data-testid`), each `;`-separated.
  const tid = testidProp(c);
  const cls = [`prop.className "${className}"`, tid, extraProps].filter(Boolean).join("; ");
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

/** Toolbar — a page-header row (space-between flex container).  Its a11y
 *  contract makes it a labelled ARIA `toolbar` (default name "Actions"). */
function primitiveToolbar(c: Ctx): string {
  const a11y = `prop.role "toolbar"; prop.ariaLabel ${ariaLabelExpr(c, `"Actions"`)}`;
  return containerEl("div", "flex flex-row items-center justify-between gap-2 py-2", c, a11y);
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
  // The title is a user-visible slot, so under i18n (M-T1.11) it arrives as an
  // already-rendered `Html.text (…)` element rather than raw text — `asChild`
  // takes either form (splicing the element into a string literal would emit
  // the whole `I18n.t` call as text).
  if (c.hasTitle) kids.push(`Html.strong [ ${asChild(String(c.title ?? ""))} ]`);
  kids.push(asChild(String(c.message ?? "")));
  const variant = alertVariant(String(c.color ?? "red"));
  return `Html.div [ prop.className "alert ${variant}"; prop.role "alert"; prop.children [ ${kids.join("; ")} ] ]`;
}

/** Empty("No results") — a centred, muted empty-state placeholder. */
function primitiveEmpty(c: Ctx): string {
  return `Html.div [ prop.className "flex min-h-40 flex-col items-center justify-center gap-2 text-center text-base-content/70"; prop.children [ ${asChild(String(c.text ?? ""))} ] ]`;
}

/** Skeleton — a loading placeholder (daisyUI `skeleton`; count/height v1-fixed).
 *  Decorative: hidden from assistive tech (the loading state is announced by a
 *  Loader/status region, and the real content announces once it loads). */
function primitiveSkeleton(_c: Ctx): string {
  return `Html.div [ prop.className "skeleton h-24 w-full"; prop.ariaHidden true ]`;
}

/** KeyValueRow(label, value) — a detail-page field row (label + value cell).
 *  `label` is raw text; `childJsx` is an already-walked value element. */
function primitiveKeyValueRow(c: Ctx): string {
  const label = `Html.dt [ prop.className "text-sm font-medium text-base-content/70 sm:w-40 sm:flex-shrink-0"; prop.text "${String(c.label ?? "")}" ]`;
  // The `data-testid` rides the VALUE cell, not the whole row — the detail page
  // object reads `field(name).innerText()` expecting just the value ("Confirmed"),
  // so it must not include the label text.
  const tid = testidProp(c);
  const valueTid = tid ? `${tid}; ` : "";
  const value = `Html.dd [ ${valueTid}prop.className "text-sm text-base-content"; prop.children [ ${asChild(String(c.childJsx ?? ""))} ] ]`;
  return `Html.div [ prop.className "flex flex-col gap-1 py-1 sm:flex-row sm:gap-4"; prop.children [ ${label}; ${value} ] ]`;
}

/** Anchor(label, to?) — a link.  With a `to:` route it hrefs the History-API
 *  PATH (`/products`), matching the path-mode router; without one it's a plain
 *  text span (breadcrumb leaf).  `to` is a JS expression (a quoted literal or a
 *  ref) — a literal folds into a static `"/path"`, a ref is used verbatim. */
function primitiveAnchor(c: Ctx): string {
  // The label is a user-visible slot — raw text normally, an already-rendered
  // `Html.text (I18n.t …)` element under i18n (M-T1.11).  The no-`to` branch
  // takes either through `asChild` (byte-identical for raw text); the linked
  // branch needs the Badge/Button split, since `prop.text` takes a string.
  const label = String(c.label ?? "");
  if (!c.hasTo) return `Html.span [ ${asChild(label)} ]`;
  const to = String(c.to ?? '"/"');
  const lit = to.match(/^"(.*)"$/);
  const href = lit ? `"${lit[1]}"` : `${to}`;
  const inner = textOrChildren(label);
  // Plain daisyUI `link` (underlined, inherits `base-content`) — NOT
  // `link-primary`: several daisyUI themes' primary colour fails WCAG AA on
  // `base-100` (e.g. `corporate` #4d6eff → 4.2:1 < 4.5:1, an axe serious
  // color-contrast violation).  `base-content` is theme-guaranteed readable, and
  // the underline carries the link affordance without relying on colour (1.4.1).
  return `Html.a [ prop.className "link"; prop.href ${href}; ${inner} ]`;
}

/** Table(rows:, ...Column(header, accessor)) — the list-page data table.  Rows
 *  iterate `rowsExpr` via a `yield! … |> List.map` (offside-safe inside the
 *  `[ … ]` children list); each column is a header cell + a per-row value cell
 *  (the accessor already walked against the row var). */
function primitiveTable(c: Ctx): string {
  const cols =
    (c.columns as unknown as
      | { header: string; headerMarkup?: boolean; cellJsx: string }[]
      | undefined) ?? [];
  const rowsExpr = String(c.rowsExpr ?? "[]");
  const rowVar = String(c.rowVar ?? "row");
  // A `sortable:` column's header is an ELEMENT (the clickable sort button the
  // target rendered), not text — so it goes into the cell's children rather
  // than being wrapped in `Html.text "…"`, which would emit the whole button as
  // a string literal.  The flag comes from the walker; the header text itself
  // is never inspected for markup (a label of "(net)" is still just a label).
  const headCells = cols
    .map((col) =>
      col.headerMarkup
        ? `Html.th [ prop.children [ ${col.header} ] ]`
        : `Html.th [ Html.text "${col.header}" ]`,
    )
    .join("; ");
  const bodyCells = cols
    .map((col) => `Html.td [ prop.children [ ${asChild(col.cellJsx)} ] ]`)
    .join("; ");
  const head = `Html.thead [ prop.children [ Html.tr [ prop.children [ ${headCells} ] ] ] ]`;
  // Per-row `data-testid` (the list-table `rowTestid:` lambda → `"orders-row-" +
  // row.id`, already rendered as an F# expression by the active target).  A
  // contained-collection table carries no `rowTestid` — the row stays testid-less
  // (that per-row testid is under-delivered on every frontend, out of scope).
  const rowTidPart = c.rowTestid ? `prop.custom("data-testid", (${String(c.rowTestid)})); ` : "";
  // The `yield!` + its bracket-delimited body are offside-safe inside the
  // enclosing `prop.children [ … ]`.
  const body =
    `Html.tbody [ prop.children [\n` +
    `      yield! ${rowsExpr} |> List.map (fun ${rowVar} ->\n` +
    `        Html.tr [ ${rowTidPart}prop.children [ ${bodyCells} ] ])\n` +
    `    ] ]`;
  // daisyUI `table table-zebra`, wrapped in a bordered, horizontally-scrollable
  // surface so wide tables stay contained.  Paren-wrapped against sibling
  // absorption (§24) since the wrapper is now the returned element.  The `rows()`
  // page-object locator reads the CONTAINER's `data-testid`, so it rides here.
  const tid = testidProp(c);
  const tidPart = tid ? `${tid}; ` : "";
  const table = `Html.table [ prop.className "table table-zebra w-full"; prop.children [ ${head}; ${body} ] ]`;
  return `(Html.div [ ${tidPart}prop.className "overflow-x-auto rounded-box border border-base-300"; prop.children [ ${table} ] ])`;
}

/** DataGrid — daisyUI chrome around a TanStack `table-core` instance
 *  (M-T1.1 slice 10e).
 *
 *  The `table` binding, the column defs and every state slice come from the
 *  walker-emitted `[<ReactComponent>]` child that wraps this markup
 *  (`src/generator/feliz/data-grid-child.ts`); a pack only decides how the grid
 *  LOOKS, never how the row model works — the same contract the `.hbs` packs
 *  honour on React/Vue/Svelte/Angular.
 *
 *  `headerBody` / `cellBody` are the walker's header + cell CONTENT, spliced
 *  where `h` (a header), `c` (a cell) and `table` are bound.  Feliz needs that
 *  split for the same reason Vue and Svelte do: a TanStack `cell` function must
 *  return framework nodes, and the walker produces markup. */
function primitiveDataGrid(c: Ctx): string {
  const headerBody = String(c.headerBody ?? "Html.none");
  const cellBody = String(c.cellBody ?? "Html.none");
  const tid = testidProp(c);
  const tidPart = tid ? `${tid}; ` : "";

  // Pack chrome (M-T1.11) — the pager labels and the filter placeholder.  The
  // walker hands them as F# EXPRESSIONS (`localizedChromeValue`), not markup
  // fragments: `prop.text` / `prop.placeholder` take a value, so the `.hbs`
  // packs' attribute-fragment form is the wrong shape here.  i18n off → the
  // plain F# literal `"Previous"`, byte-identical to the pre-i18n pager; on →
  // `(I18n.t "chrome.previous" "Previous")` through the `renderTranslate` seam,
  // keyed to the same shared catalog every other frontend uses.
  const prevLabel = String(c.prevLabelValue ?? '"Previous"');
  const nextLabel = String(c.nextLabelValue ?? '"Next"');
  const filterPlaceholder = String(c.filterPlaceholderValue ?? '"Filter"');

  // Column-visibility toggles.  A column whose header is blank (the selection
  // column) falls back to its id so the checkbox still has a label.
  const visibility = c.hasColumnVisibility
    ? `\n      Html.div [ prop.className "flex flex-wrap gap-3"; prop.children [\n` +
      `        yield! unbox<obj array> (table?getAllLeafColumns()) |> Array.map (fun col ->\n` +
      `          Html.label [ prop.className "flex items-center gap-1 text-sm"; prop.children [\n` +
      `            Html.input [ prop.type' "checkbox"; prop.isChecked (unbox<bool> (col?getIsVisible())); prop.onChange (fun (_: bool) -> loomInvoke (col?toggleVisibility)) ]\n` +
      `            Html.text (let __h = loomText (col?columnDef?header) in if __h = "" then unbox<string> (col?id) else __h) ] ])\n` +
      `      ] ]`
    : "";

  // Per-column filter input, under the header content — only for columns whose
  // `filterable:` survived resolution (`getCanFilter()` is TanStack's answer).
  // Under i18n an `I18n.tf` call over `chrome.filterBy`; off, the
  // `renderStringConcat` seam re-spells the same `("Filter by " + loomText …)`
  // this pack wrote by hand.
  const filterByAria = String(
    c.filterByAriaValue ?? '("Filter by " + loomText (h?column?columnDef?header))',
  );
  const filterInput = c.hasFilters
    ? `\n                  if unbox<bool> (h?column?getCanFilter()) then\n` +
      `                    Html.input [ prop.type' "search"; prop.className "input input-xs input-bordered mt-1 w-full"; prop.placeholder ${filterPlaceholder}; prop.ariaLabel ${filterByAria}; prop.value (loomText (h?column?getFilterValue())); prop.onChange (fun (v: string) -> loomHandle (h?column?setFilterValue) (box v)) ]`
    : "";

  // `aria-sort` on the header cell is the a11y contract the JSX packs already
  // ship (M-T1.1 slice 5); a sortable header without it is a WCAG gap.
  const head =
    `Html.thead [ prop.children [\n` +
    `        yield! unbox<obj array> (table?getHeaderGroups()) |> Array.map (fun hg ->\n` +
    `          Html.tr [ prop.children [\n` +
    `            yield! unbox<obj array> (hg?headers) |> Array.map (fun h ->\n` +
    `              Html.th [ prop.custom("aria-sort", (match loomText (h?column?getIsSorted()) with | "asc" -> "ascending" | "desc" -> "descending" | _ -> "none")); prop.children [\n` +
    `                  ${headerBody}${filterInput}\n` +
    `                ] ]) ] ])\n` +
    `      ] ]`;

  const body =
    `Html.tbody [ prop.children [\n` +
    `        yield! unbox<obj array> (table?getRowModel()?rows) |> Array.map (fun r ->\n` +
    `          Html.tr [ prop.children [\n` +
    `            yield! unbox<obj array> (r?getVisibleCells()) |> Array.map (fun c ->\n` +
    `              Html.td [ prop.children [ ${cellBody} ] ]) ] ])\n` +
    `      ] ]`;

  // `Math.max(pageCount, 1)` on the JSX packs — an empty grid still reads
  // "Page 1 of 1" rather than "of 0".
  //
  // Under i18n the counter arrives already bound (`localizedChromeIcuValue`, an
  // `I18n.tf` call over `chrome.pageOf` whose locale may re-order the two
  // numbers); with i18n off it is `undefined` and this concatenation — the
  // sentence this pack has always spelled — stands unchanged.
  const pageOf =
    c.pageOfLabelValue ??
    `("Page " + string (unbox<int> (table?getState()?pagination?pageIndex) + 1) + " of " + string (max (unbox<int> (table?getPageCount())) 1))`;
  const pager =
    `\n      Html.div [ prop.className "flex items-center justify-between"; prop.children [\n` +
    `        Html.button [ prop.className "btn btn-xs"; prop.disabled (not (unbox<bool> (table?getCanPreviousPage()))); prop.onClick (fun _ -> loomInvoke (table?previousPage)); prop.text ${prevLabel} ]\n` +
    `        Html.span [ prop.className "text-sm"; prop.custom("aria-live", "polite"); prop.text ${pageOf} ]\n` +
    `        Html.button [ prop.className "btn btn-xs"; prop.disabled (not (unbox<bool> (table?getCanNextPage()))); prop.onClick (fun _ -> loomInvoke (table?nextPage)); prop.text ${nextLabel} ]\n` +
    `      ] ]`;

  const table =
    `\n      Html.div [ prop.className "overflow-x-auto rounded-box border border-base-300"; prop.children [\n` +
    `        Html.table [ prop.className "table table-zebra w-full"; prop.children [ ${head}; ${body} ] ]\n` +
    `      ] ]`;

  return (
    `(Html.div [ ${tidPart}prop.className "flex flex-col gap-2"; prop.children [` +
    `${visibility}${table}${pager}\n    ] ])`
  );
}

/** IdLink — a table-cell link from a row id to its detail page.  Hrefs the
 *  History-API PATH (`/products/<id>`), matching the path-mode router; the id is
 *  the visible label. */
function primitiveIdLink(c: Ctx): string {
  const idExpr = String(c.idExpr ?? '""');
  const prefix = String(c.pathPrefix ?? "/");
  // Plain `link` (not `link-primary`) for AA colour contrast — see primitiveAnchor.
  return `Html.a [ prop.className "link"; prop.href ("${prefix}" + ${idExpr}); prop.text (string (${idExpr})) ]`;
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
  const tid = testidProp(c);
  const tidPart = tid ? `${tid}; ` : "";
  return `Html.div [ ${tidPart}prop.className "card bg-base-100 shadow"${body} ]`;
}

function primitiveBadge(c: Ctx): string {
  // The label is a user-visible slot — raw text, or an already-rendered
  // `Html.text (I18n.t …)` element under i18n (M-T1.11).
  const inner = textOrChildren(String(c.label ?? ""));
  return `Html.span [ prop.className "badge badge-neutral"; ${inner} ]`;
}

/** Divider — a daisyUI rule.  An optional `label:` rides INSIDE the rule
 *  (`<div class="divider">Section break</div>` is daisyUI's labelled form), so
 *  the slot is a real user-visible string here rather than a dropped one: it was
 *  extracted into `.loom/messages.en.json` but rendered nowhere, which handed a
 *  translator a string the app never shows.  Raw text with i18n off, an
 *  already-rendered `Html.text ((I18n.t …))` element with it on. */
function primitiveDivider(c: Ctx): string {
  // `testid:` was dropped here, so the shared testid-driven page objects could
  // not target a Divider on Feliz (every other primitive carries it).
  const tid = testidProp(c);
  const props = [`prop.className "divider"`, tid].filter(Boolean);
  if (c.hasLabel) props.push(textOrChildren(String(c.label ?? "")));
  return `Html.div [ ${props.join("; ")} ]`;
}

function primitiveButton(c: Ctx): string {
  // A Feliz element list is EITHER all children (ReactElement) OR all props
  // (IReactProperty) — never mixed.  A button carries an onClick prop, so the
  // label goes through a prop too: `prop.text` for a plain string, or
  // `prop.children [ … ]` when the label is an already-rendered element.  The
  // daisyUI `btn btn-primary` class makes it a real design-system button.
  const props: string[] = [`prop.className "btn btn-primary"`];
  const tid = testidProp(c);
  if (tid) props.push(tid);
  if (c.hasOnClick) props.push(`prop.onClick (${c.onClick})`);
  // `label:` supplies an explicit accessible name (the a11y contract's needsName)
  // — emitted as prop.ariaLabel when the visible text is an unhelpful glyph.
  const aria = ariaLabelExpr(c);
  if (aria !== undefined) props.push(`prop.ariaLabel ${aria}`);
  // The label is a user-visible slot — raw text, or an already-rendered
  // `Html.text (I18n.t …)` element under i18n (M-T1.11).
  props.push(textOrChildren(String(c.label ?? "")));
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
 *  literal can't span lines, so real newlines in the source escape to `\n`.
 *
 *  The `title:` caption is a user-visible slot, so under i18n it arrives as an
 *  already-rendered `Html.text (I18n.t …)` element rather than raw text — hence
 *  `textOrChildren` rather than a spliced `prop.text "…"`.  The code SOURCE is
 *  not a slot and stays a literal. */
function primitiveCodeBlock(c: Ctx): string {
  const source = String(c.source ?? "").replace(/\n/g, "\\n");
  const pre = `Html.pre [ prop.className "overflow-x-auto rounded-md border border-base-300 bg-base-200 p-4 text-sm"; prop.children [ Html.code [ prop.text "${source}" ] ] ]`;
  if (!c.hasTitle) return pre;
  const title = `Html.div [ prop.className "border-b border-base-300 px-4 py-2 text-xs font-medium text-base-content/70"; ${textOrChildren(String(c.titleText ?? ""))} ]`;
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
/** Loader() — a centred daisyUI spinner (size v1-fixed).  The spinner is a
 *  raw `<span>` (not a library component), so it carries its own status
 *  semantics: `role="status"` + an accessible name so assistive tech
 *  announces the busy state (WCAG 4.1.2). */
function primitiveLoader(_c: Ctx): string {
  return `Html.div [ prop.className "flex justify-center py-8"; prop.children [ Html.span [ prop.className "loading loading-spinner loading-lg text-primary"; prop.role "status"; prop.ariaLabel "Loading" ] ] ]`;
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

/** Icon(name|svg, size?) — an inline SVG.  The registry/user SVG is injected
 *  verbatim via `dangerouslySetInnerHTML` (Feliz's raw-HTML escape hatch); the
 *  span sizes it and a child-selector variant makes the inner `<svg>` fill.  A
 *  triple-quoted F# string carries the markup as-is — the SVGs embed `"` (never
 *  `"""`), so no escaping is needed.  `size:` → a fixed h/w utility. */
function primitiveIcon(c: Ctx): string {
  const svg = String(c.svg ?? "");
  const size =
    c.size === "sm"
      ? "h-4 w-4"
      : c.size === "lg"
        ? "h-6 w-6"
        : c.size === "xl"
          ? "h-8 w-8"
          : "h-5 w-5";
  const cls = `loom-icon inline-flex ${size} [&>svg]:h-full [&>svg]:w-full`;
  // Decorative-by-default (icon a11y contract): hide the glyph from assistive
  // tech unless a `label:` gives it meaning, in which case it becomes a named
  // `img`.  Feliz emits F# `prop.*` props rather than the HTML `a11yAttr`, so
  // the name arrives as the already-translated VALUE (D-I18N-ATTR) — the walker
  // has already decided decorative-vs-named, and hands `ariaLabelExpr` only for
  // the named case.  It used to read the RAW `label:`, shipping the accessible
  // name in English at every locale.
  const name = ariaLabelExpr(c);
  const a11yProps =
    name !== undefined ? `prop.role "img"; prop.ariaLabel ${name}; ` : `prop.ariaHidden true; `;
  return `Html.span [ prop.className "${cls}"; ${a11yProps}prop.dangerouslySetInnerHTML """${svg}""" ]`;
}

/** Tabs(Tab("A", …), Tab("B", …)) — daisyUI's CSS-only radio-tabs: one
 *  `<input type=radio role=tab>` per tab (sharing a `name` so exactly one is
 *  active) followed by its `tab-content` panel.  Pure CSS switching — no MVU
 *  state — so a Tabs group needs no Model field.  The group `name` is derived
 *  from the tab values so distinct groups on a page don't share a radio set.
 *  Each panel's body is an already-walked F# element (offside-safe on its own
 *  line inside the panel's `children [ … ]`). */
function primitiveTabs(c: Ctx): string {
  const tabs = (c.tabs as unknown as { value: string; label: string; bodyJsx: string }[]) ?? [];
  if (tabs.length === 0) return "Html.none";
  const group = `loom_tabs_${tabs.map((t) => t.value).join("_")}`;
  const parts = tabs.flatMap((t, i) => {
    const radioProps = [
      "prop.type'.radio",
      `prop.name "${group}"`,
      'prop.role "tab"',
      'prop.className "tab"',
      `prop.ariaLabel "${t.label}"`,
      // The first tab is active by default (uncontrolled — CSS owns the switch).
      ...(i === 0 ? ["prop.defaultChecked true"] : []),
    ];
    const body = asElement(t.bodyJsx);
    return [
      `    Html.input [ ${radioProps.join("; ")} ]`,
      `    Html.div [ prop.role "tabpanel"; prop.className "tab-content p-4"; prop.children [\n      ${body}\n    ] ]`,
    ];
  });
  return `(Html.div [ prop.role "tablist"; prop.className "tabs tabs-bordered"; prop.children [\n${parts.join(
    "\n",
  )}\n  ] ])`;
}

// --- Controlled input primitives (MVU two-way binding) --------------------
// Each binds a page `state` field: it READS `model.<Field>` and its `onChange`
// DISPATCHES `Set<Field>` — the Msg + update arm the MVU projection emits from
// `collectPageBoundState` (update-emit.ts).  `c.bind` is the state field name;
// the setter Msg is `Set<Pascal(bind)>` (matching `boundSetMsg`).  An input with
// no resolvable state bind (`hasBind` false) renders an uncontrolled stub so the
// page still compiles.

/** The daisyUI label above a form-control input (skipped when the label is
 *  empty — e.g. a bare `Field(bind: x)`). */
function inputLabel(labelText: string): string {
  return labelText.trim() === ""
    ? ""
    : `Html.label [ prop.className "label"; prop.children [ Html.span [ prop.className "label-text"; prop.text "${labelText}" ] ] ]`;
}

/** A stable id for a field's inline error element, derived from its bound state
 *  field (`name` → `name-error`) so the input can point `aria-describedby` at it.
 *  Empty when the field isn't bound (an uncontrolled stub carries no error). */
function fieldErrorId(c: Ctx): string {
  const bind = String(c.bind ?? "").trim();
  return bind === "" ? "" : `${bind}-error`;
}

/** The a11y props that link a raw input to its error state: `aria-invalid`
 *  reflects the RUNTIME error (`errorExpr <> ""` — empty string means valid) and
 *  `aria-describedby` points at the inline error element so a screen reader
 *  announces the message with the field.  Empty (no leading `;`) when the field
 *  has no error binding.  Each returned fragment starts with `; ` so it slots
 *  straight into an existing Feliz prop list after the className. */
function fieldAriaProps(c: Ctx): string {
  if (!c.hasError) return "";
  const invalid = `; prop.ariaInvalid (${String(c.error)} <> "")`;
  const id = fieldErrorId(c);
  return id === "" ? invalid : `${invalid}; prop.ariaDescribedBy "${id}"`;
}

/** The inline error line under an input — bound to the walked `error:` F#
 *  expression (empty string at runtime → an empty line, harmless).  Carries the
 *  `id` the input's `aria-describedby` references (a11y). */
function inputError(c: Ctx): string {
  if (!c.hasError) return "";
  const id = fieldErrorId(c);
  const idProp = id === "" ? "" : `prop.id "${id}"; `;
  return `Html.label [ ${idProp}prop.className "label"; prop.children [ Html.span [ prop.className "label-text-alt text-error"; prop.text (${String(c.error)}) ] ] ]`;
}

/** Wrap a controlled input element in a daisyUI `form-control` with its label +
 *  optional inline error.  Multi-child, but single-line-safe (inputs are flat). */
function formControl(c: Ctx, inputEl: string): string {
  const parts = [inputLabel(String(c.labelText ?? "")), inputEl, inputError(c)].filter(
    (p) => p !== "",
  );
  const tid = testidProp(c);
  const tidPart = tid ? `${tid}; ` : "";
  return `Html.div [ ${tidPart}prop.className "form-control w-full"; prop.children [ ${parts.join("; ")} ] ]`;
}

/** The `Set<Field>` Msg name + Model read for a bound input, or undefined when
 *  the `bind:` didn't resolve to a state field (→ uncontrolled stub). */
function bindTargets(c: Ctx): { model: string; setMsg: string } | undefined {
  const bind = String(c.bind ?? "");
  if (!c.hasBind || bind === "") return undefined;
  const field = upperFirst(bind);
  return { model: `model.${field}`, setMsg: `Set${field}` };
}

/** Field — a controlled daisyUI text input bound to a string state field. */
function primitiveField(c: Ctx): string {
  const t = bindTargets(c);
  const input = t
    ? `Html.input [ prop.className "input input-bordered w-full"${fieldAriaProps(c)}; prop.value ${t.model}; prop.onChange (fun (v: string) -> dispatch (${t.setMsg} v)) ]`
    : `Html.input [ prop.className "input input-bordered w-full"${fieldAriaProps(c)} ]`;
  return formControl(c, input);
}

/** MultilineField — a controlled `<textarea>` bound to a string state field. */
function primitiveMultilineField(c: Ctx): string {
  const t = bindTargets(c);
  const input = t
    ? `Html.textarea [ prop.className "textarea textarea-bordered w-full"${fieldAriaProps(c)}; prop.value ${t.model}; prop.onChange (fun (v: string) -> dispatch (${t.setMsg} v)) ]`
    : `Html.textarea [ prop.className "textarea textarea-bordered w-full"${fieldAriaProps(c)} ]`;
  return formControl(c, input);
}

/** PasswordField — a controlled password input bound to a string state field. */
function primitivePasswordField(c: Ctx): string {
  const t = bindTargets(c);
  const input = t
    ? `Html.input [ prop.className "input input-bordered w-full"${fieldAriaProps(c)}; prop.type'.password; prop.value ${t.model}; prop.onChange (fun (v: string) -> dispatch (${t.setMsg} v)) ]`
    : `Html.input [ prop.className "input input-bordered w-full"${fieldAriaProps(c)}; prop.type'.password ]`;
  return formControl(c, input);
}

/** NumberField — a controlled number input bound to an int/decimal state field.
 *  `onChange` dispatches the raw string; the update arm parses it (so partial
 *  input never throws).  The value is stringified for display. */
function primitiveNumberField(c: Ctx): string {
  const t = bindTargets(c);
  const input = t
    ? `Html.input [ prop.className "input input-bordered w-full"${fieldAriaProps(c)}; prop.type'.number; prop.value (string ${t.model}); prop.onChange (fun (v: string) -> dispatch (${t.setMsg} v)) ]`
    : `Html.input [ prop.className "input input-bordered w-full"${fieldAriaProps(c)}; prop.type'.number ]`;
  return formControl(c, input);
}

/** SelectField — a controlled `<select>` over an `options:` string sequence,
 *  bound to a string state field.  `Seq.map` tolerates a list OR array options
 *  expression; `yield!` is offside-safe inside the children list. */
function primitiveSelectField(c: Ctx): string {
  const t = bindTargets(c);
  const options = String(c.optionsExpr ?? "[]");
  const opts = `yield! (${options}) |> Seq.map (fun o -> Html.option [ prop.value o; prop.text o ])`;
  const input = t
    ? `Html.select [ prop.className "select select-bordered w-full"${fieldAriaProps(c)}; prop.value ${t.model}; prop.onChange (fun (v: string) -> dispatch (${t.setMsg} v)); prop.children [ ${opts} ] ]`
    : `Html.select [ prop.className "select select-bordered w-full"${fieldAriaProps(c)}; prop.children [ ${opts} ] ]`;
  return formControl(c, input);
}

/** FileUpload — a daisyUI file input bound to a `File`-typed state field.  On
 *  select it dispatches `Select<Field>File` carrying the picked browser file
 *  (Feliz's typed `onChange (File -> unit)` overload reads `files.[0]`); the MVU
 *  update arm POSTs it to `/files` via `Api.uploadFile` and stores the returned
 *  `FileRef` on the Model (`<Field> = Some ref`).  An unresolved bind renders an
 *  uncontrolled stub (no dispatch) so the page still compiles. */
function primitiveFileUpload(c: Ctx): string {
  const bind = String(c.bind ?? "").trim();
  const cls = 'prop.className "file-input file-input-bordered w-full"';
  const input =
    c.hasBind && bind !== ""
      ? `Html.input [ ${cls}; prop.type'.file; prop.onChange (fun (file: Browser.Types.File) -> dispatch (Select${upperFirst(bind)}File file)) ]`
      : `Html.input [ ${cls}; prop.type'.file ]`;
  return formControl(c, input);
}

/** Toggle — a controlled daisyUI checkbox toggle bound to a bool state field.
 *  Renders the label inline (daisyUI's `label cursor-pointer` row) rather than
 *  above, matching the toggle's horizontal affordance. */
function primitiveToggle(c: Ctx): string {
  const t = bindTargets(c);
  const input = t
    ? `Html.input [ prop.className "toggle"${fieldAriaProps(c)}; prop.type'.checkbox; prop.isChecked ${t.model}; prop.onChange (fun (v: bool) -> dispatch (${t.setMsg} v)) ]`
    : `Html.input [ prop.className "toggle"${fieldAriaProps(c)}; prop.type'.checkbox ]`;
  const labelText = String(c.labelText ?? "");
  const span =
    labelText.trim() === ""
      ? ""
      : `Html.span [ prop.className "label-text"; prop.text "${labelText}" ]; `;
  const row = `Html.label [ prop.className "label cursor-pointer justify-start gap-3"; prop.children [ ${span}${input} ] ]`;
  if (!c.hasError)
    return `Html.div [ prop.className "form-control w-full"; prop.children [ ${row} ] ]`;
  return `Html.div [ prop.className "form-control w-full"; prop.children [ ${row}; ${inputError(c)} ] ]`;
}

/** Controlled Modal — a daisyUI dialog whose visibility is a bool state field
 *  (`open: <stateBool>`).  Open by dispatching a sibling action that sets it
 *  true; the built-in Close button dispatches `Set<Opened> false`.  Children are
 *  the walked modal body (offside-safe on their own line inside `modal-box`). */
function primitiveModalControlled(c: Ctx): string {
  const opened = String(c.opened ?? "");
  const field = upperFirst(opened);
  const model = `model.${field}`;
  const close = `Set${field}`;
  const kids: string[] = [];
  // The title is a user-visible slot — raw text normally, an already-rendered
  // `Html.text (I18n.t …)` element under i18n (M-T1.11).  `prop.text` takes a
  // string, so the element form goes through `prop.children` instead (the same
  // split `Badge`/`Button`/`Anchor` use); raw text stays byte-identical.
  if (c.hasTitle)
    kids.push(
      `Html.h3 [ prop.className "text-lg font-bold"; ${textOrChildren(String(c.title ?? ""))} ]`,
    );
  const body = asElement(String(c.childrenJsx ?? ""));
  const action = `Html.div [ prop.className "modal-action"; prop.children [ Html.button [ prop.className "btn"; prop.onClick (fun _ -> dispatch (${close} false)); prop.text "Close" ] ] ]`;
  const boxKids = [...kids, body, action].join("\n    ");
  return `(Html.div [ prop.className (if ${model} then "modal modal-open" else "modal"); prop.children [\n  Html.div [ prop.className "modal-box"; prop.children [\n    ${boxKids}\n  ] ]\n] ])`;
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
  "primitive-data-grid": primitiveDataGrid,
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
  // Stateless leaf/layout primitives (no MVU binding).
  "primitive-icon": primitiveIcon,
  "primitive-tabs": primitiveTabs,
  // Controlled inputs (two-way state binding → Set<Field> Msg dispatch).
  "primitive-field": primitiveField,
  "primitive-multiline-field": primitiveMultilineField,
  "primitive-password-field": primitivePasswordField,
  "primitive-number-field": primitiveNumberField,
  "primitive-select-field": primitiveSelectField,
  "primitive-file-upload": primitiveFileUpload,
  "primitive-toggle": primitiveToggle,
  "primitive-modal-controlled": primitiveModalControlled,
};

/** Build the procedural Feliz pack.  Implements the `LoadedPack` render
 *  contract without Handlebars — the loader's template path is unused here.
 *
 *  `templates` is normally empty (the procedural pack renders via `RENDERERS`,
 *  not compiled `.hbs`), but `emitControlledModal` (walker `forms.ts`) gates the
 *  state-controlled `Modal` on `pack.templates.has("primitive-modal-controlled")`
 *  — a capability probe, not a render call (only `.has()` is used, never
 *  `.get()`).  Seed that one key so the procedural renderer is recognised; the
 *  sentinel value is never invoked. */
export function felizPack(): LoadedPack {
  const templates = new Map([
    ["primitive-modal-controlled", { fn: () => "", filePath: "<feliz-procedural>" }],
  ]) as unknown as LoadedPack["templates"];
  return {
    manifest: { name: "felizBasic", version: "v1", format: "tsx", emits: {}, imports: {} },
    rootDir: "<feliz-procedural>",
    templates,
    // No `.hbs` templates, so no pack-DECLARED chrome to bind: this pack's
    // user-visible strings are emitted procedurally and already ride the
    // curated `chrome.*` catalog (D-I18N-ATTR / `localizedChrome*`).
    setChromeI18n() {},
    render(name: string, context: unknown): string {
      const fn = RENDERERS[name];
      if (!fn) return `(* feliz pack: no renderer for "${name}" *)`;
      return fn((context ?? {}) as Ctx);
    },
  };
}
