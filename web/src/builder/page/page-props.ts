import { AstUtils, GrammarUtils, type AstNode, type CstNode } from "langium";
import type {
  BodyProp,
  Expression,
  Model,
  Page,
  PageMenuMeta,
  PageProp,
  Ui,
} from "../../../../src/language/generated/ast.js";
import { isLayout, isUi } from "../../../../src/language/generated/ast.js";
import { parseDdd } from "../parse";
import { applyEdits, nodeEditRange } from "../edit-engine";

// ---------------------------------------------------------------------------
// Inline editing of a page's SCALAR props — `route:` / `title:` / `requires` /
// `layout:` / `description:` / `ogImage:` / `canonical:` and the per-page
// `menu { … }` metadata block — from the page builder's chrome.
//
// Same discipline as `state-fields.ts` (its sibling) and the Model builder's
// `system/fields.ts`: every op re-parses the source (input guard — a source the
// parser rejects is refused rather than spliced at offsets error recovery
// invented), locates the page, rewrites the SMALLEST CST range that expresses
// the change, then re-parses the result (output guard — a candidate that no
// longer parses is discarded and the caller keeps the original source).  Nothing
// is reprinted through the structural printer, so comments, blank lines and
// hand-alignment (`route:    "/x"`) outside the edited span are byte-preserved.
//
// SET replaces only the prop's VALUE node, so the keyword and its spacing
// survive.  ADD splices one whole line at the canonical position (see
// `PROP_ORDER`).  REMOVE swallows the prop's line plus its leading indentation
// so no blank line is left behind.
//
// Page-only surface: a `component` body has no route/title/menu of its own
// (`ComponentDecl` is `StateBlock | DerivedProp | ActionDecl`), so every entry
// point here resolves a `Page` and returns null for anything else.
// ---------------------------------------------------------------------------

/** The scalar (single-valued, one-line) page props this module edits. */
export type ScalarPropKey =
  | "route"
  | "title"
  | "requires"
  | "layout"
  | "description"
  | "ogImage"
  | "canonical";

/** Recognised `menu { … }` metadata keys (validator `ui.ts` pins the same set). */
export type MenuMetaKey = "section" | "label" | "order" | "hidden";

export const MENU_META_KEYS: readonly MenuMetaKey[] = ["section", "label", "order", "hidden"];

/** Menu metadata as EXPRESSION SOURCE TEXT (`"Sales"`, `0`, `true`) — the same
 *  text the setters take, so a read→write round-trip is lossless. */
export interface PageMenuInfo {
  section?: string;
  label?: string;
  order?: string;
  hidden?: string;
}

export interface PagePropsInfo {
  /** `route:` — the string literal's CONTENT (delimiters stripped by Langium). */
  route?: string;
  /** `title:` — expression source text (`"Orders for " + customer.name`). */
  title?: string;
  /** `requires` — expression source text. */
  requiresText?: string;
  /** `layout:` — the bare ref name (`default` / `none` / a `layout X { … }` name). */
  layout?: string;
  description?: string;
  ogImage?: string;
  canonical?: string;
  /** Present (possibly empty) always; `{}` when the page declares no `menu { }`. */
  menu: PageMenuInfo;
  /** False when the page has no `menu { … }` block at all. */
  hasMenu: boolean;
}

// --- prop table ------------------------------------------------------------

type PropKind = PageProp["$type"];

interface PropSpec {
  /** The `PageProp` subtype this key maps to. */
  kind: PropKind;
  /** How the value is written: quoted STRING, bare ID, or raw expression text. */
  form: "string" | "id" | "expr";
  /** Rendered line for an inserted prop. */
  line: (value: string) => string;
}

const PROPS: Record<ScalarPropKey, PropSpec> = {
  route: { kind: "RouteProp", form: "string", line: (v) => `route: ${JSON.stringify(v)}` },
  title: { kind: "TitleProp", form: "expr", line: (v) => `title: ${v}` },
  description: { kind: "DescriptionProp", form: "string", line: (v) => `description: ${JSON.stringify(v)}` },
  ogImage: { kind: "OgImageProp", form: "string", line: (v) => `ogImage: ${JSON.stringify(v)}` },
  canonical: { kind: "CanonicalProp", form: "string", line: (v) => `canonical: ${JSON.stringify(v)}` },
  layout: { kind: "LayoutProp", form: "id", line: (v) => `layout: ${v}` },
  // `requires <expr>` — no colon (grammar: `RequiresProp: 'requires' expr=Expression`).
  requires: { kind: "RequiresProp", form: "expr", line: (v) => `requires ${v}` },
};

// Canonical head-of-page ordering, taken from the corpus (examples/showcase.ddd
// `page Kitchen`, examples/sales-ui.ddd `page OrderConsole`): the scalar props
// sit above `state { }` / `body:`, in this order.  An inserted prop lands after
// the last lower-ordered prop already present, else before the first
// higher-ordered one — so the group stays sorted however it was built up.
const PROP_ORDER: readonly ScalarPropKey[] = [
  "route",
  "title",
  "description",
  "ogImage",
  "canonical",
  "layout",
  "requires",
];

const KIND_OF_ORDER = PROP_ORDER.map((k) => PROPS[k].kind);

// --- locate ----------------------------------------------------------------

function uiOf(page: Page): Ui | undefined {
  return AstUtils.getContainerOfType(page, isUi);
}

// Resolution mirrors BuilderPane's `collectBodies`: stream the whole AST and
// match `Page` nodes by name — which picks up pages nested in an `area { }`
// (AreaMember = Page | Area) for free.  `uiName` is an optional disambiguator
// for the same page name declared under two `ui`s.
function findPage(ast: Model, pageName: string, uiName?: string): Page | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type !== "Page") continue;
    const page = n as Page;
    if (page.name !== pageName) continue;
    if (uiName !== undefined && uiOf(page)?.name !== uiName) continue;
    return page;
  }
  return null;
}

/** Shared prologue: re-parse (input guard) and find the page.  Null on a
 *  syntactically invalid source or an unknown page. */
function locate(source: string, pageName: string, uiName?: string): Page | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findPage(fresh.ast, pageName, uiName);
}

/** Output guard: return `candidate` only if it still parses. */
function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

/** Parse `text` as a standalone expression (the page-body wrap trick
 *  `state-fields.ts` uses); null if it doesn't parse. */
function parsesAsExpr(text: string): boolean {
  const r = parseDdd(`system S { ui U { page P { body: ${text} } } }`);
  if (r.parserErrors.length > 0) return false;
  for (const n of AstUtils.streamAst(r.ast)) {
    if (n.$type === "BodyProp") return (n as BodyProp).expr !== undefined;
  }
  return false;
}

const ID_RE = /^[_a-zA-Z][\w]*$/;

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

/** Extend `offset` backwards over the line's indentation and its newline, so a
 *  removed prop leaves no blank line behind. */
function swallowLeadingLine(source: string, offset: number): number {
  let start = offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  return start;
}

function propOfKind(page: Page, kind: PropKind): PageProp | undefined {
  return page.props.find((p) => p.$type === kind);
}

/** The narrowest CST span holding a prop's value. */
function valueCst(prop: PageProp): CstNode | undefined {
  if (prop.$type === "TitleProp") return prop.value.$cstNode ?? undefined;
  if (prop.$type === "RequiresProp") return prop.expr.$cstNode ?? undefined;
  const cst = prop.$cstNode;
  return cst ? GrammarUtils.findNodeForProperty(cst, "value") : undefined;
}

function cstText(node: AstNode | undefined): string | undefined {
  const t = node?.$cstNode?.text;
  return t === undefined ? undefined : t.trim();
}

// --- read ------------------------------------------------------------------

/** Current scalar props + menu metadata of `pageName`.  Null when the source
 *  has parser errors or the page doesn't exist (a `component` name never
 *  resolves — components carry none of these props). */
export function pageProps(source: string, pageName: string, uiName?: string): PagePropsInfo | null {
  const page = locate(source, pageName, uiName);
  if (!page) return null;
  const out: PagePropsInfo = { menu: {}, hasMenu: false };
  for (const prop of page.props) {
    switch (prop.$type) {
      case "RouteProp":
        out.route = prop.value;
        break;
      case "TitleProp":
        out.title = cstText(prop.value);
        break;
      case "RequiresProp":
        out.requiresText = cstText(prop.expr);
        break;
      case "LayoutProp":
        out.layout = prop.value;
        break;
      case "DescriptionProp":
        out.description = prop.value;
        break;
      case "OgImageProp":
        out.ogImage = prop.value;
        break;
      case "CanonicalProp":
        out.canonical = prop.value;
        break;
      case "PageMenuMeta":
        // Last block wins, matching `lower-ui.ts`.
        out.hasMenu = true;
        out.menu = {};
        for (const e of prop.entries) {
          if ((MENU_META_KEYS as readonly string[]).includes(e.name)) {
            out.menu[e.name as MenuMetaKey] = cstText(e.value);
          }
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** Layout names selectable for `layout:` — the two presets plus every
 *  `layout X { … }` declared in the model. */
export function availableLayouts(ast: Model): string[] {
  const names = new Set<string>(["default", "none"]);
  for (const n of AstUtils.streamAst(ast)) {
    if (isLayout(n)) names.add(n.name);
  }
  return [...names];
}

// --- scalar setters --------------------------------------------------------

/** Insert-above position for `prop`, jumping over its own leading comment — a
 *  `// the body itself` above `body:` documents the BODY, so the new line goes
 *  above the comment, not between it and the prop it annotates. */
function above(source: string, prop: PageProp): { at: number; indent: string } {
  const cst = prop.$cstNode;
  const start = nodeEditRange(prop, { includeLeadingComment: true })?.offset ?? cst?.offset ?? 0;
  return { at: swallowLeadingLine(source, start), indent: lineIndent(source, cst?.offset ?? start) };
}

/** Where a newly-inserted `key` line goes, as `{ at, indent }`. */
function insertionPoint(source: string, page: Page, key: ScalarPropKey): { at: number; indent: string } | null {
  const rank = PROP_ORDER.indexOf(key);
  // After the last lower-ranked scalar prop already present …
  for (let i = rank - 1; i >= 0; i--) {
    const prev = propOfKind(page, KIND_OF_ORDER[i])?.$cstNode;
    if (prev) return { at: prev.end, indent: lineIndent(source, prev.offset) };
  }
  // … else before the first higher-ranked one …
  for (let i = rank + 1; i < KIND_OF_ORDER.length; i++) {
    const next = propOfKind(page, KIND_OF_ORDER[i]);
    if (next) return above(source, next);
  }
  // … else above the first structural prop (`state {}` / `body:` / …) …
  const first = page.props[0];
  if (first) return above(source, first);
  // … else the page body is empty: open a first line after `{`.
  const cst = page.$cstNode;
  const open = cst && GrammarUtils.findNodeForKeyword(cst, "{");
  if (!cst || !open) return null;
  return { at: open.end, indent: `${lineIndent(source, cst.offset)}  ` };
}

/** Add / replace / remove one scalar prop.  `value` is the string CONTENT for
 *  `route`/`description`/`ogImage`/`canonical`, a bare ref name for `layout`,
 *  and expression SOURCE TEXT for `title`/`requires`; null removes the prop.
 *  Returns the new source, the untouched source when there was nothing to
 *  remove, or null when the edit is refused. */
export function setPageProp(
  source: string,
  pageName: string,
  key: ScalarPropKey,
  value: string | null,
  uiName?: string,
): string | null {
  const page = locate(source, pageName, uiName);
  if (!page) return null;
  const spec = PROPS[key];
  const existing = propOfKind(page, spec.kind);

  if (value === null) {
    const cst = existing?.$cstNode;
    if (!cst) return source;
    return ifParses(applyEdits(source, [{ offset: swallowLeadingLine(source, cst.offset), end: cst.end, newText: "" }]));
  }

  const text = value.trim();
  if (text === "") return setPageProp(source, pageName, key, null, uiName);
  if (spec.form === "expr" && !parsesAsExpr(text)) return null;
  if (spec.form === "id" && !ID_RE.test(text)) return null;

  if (existing) {
    // Narrowest possible splice: only the VALUE node, so the keyword and any
    // hand alignment (`route:    "/x"`) around it survive.
    const vcst = valueCst(existing);
    if (!vcst) return null;
    const rendered = spec.form === "string" ? JSON.stringify(text) : text;
    return ifParses(applyEdits(source, [{ offset: vcst.offset, end: vcst.end, newText: rendered }]));
  }

  const point = insertionPoint(source, page, key);
  if (!point) return null;
  return ifParses(
    applyEdits(source, [{ offset: point.at, end: point.at, newText: `\n${point.indent}${spec.line(text)}` }]),
  );
}

export const setPageRoute = (source: string, pageName: string, value: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "route", value, uiName);

/** `title:` takes EXPRESSION text — the grammar's `TitleProp.value` is an
 *  `Expression` (`title: "Orders for " + customer.name` is legal). */
export const setPageTitle = (source: string, pageName: string, text: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "title", text, uiName);

export const setPageRequires = (source: string, pageName: string, text: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "requires", text, uiName);

/** `layout:` takes a BARE ref name (`default` / `none` / a declared layout). */
export const setPageLayout = (source: string, pageName: string, name: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "layout", name, uiName);

export const setPageDescription = (source: string, pageName: string, value: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "description", value, uiName);

export const setPageOgImage = (source: string, pageName: string, value: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "ogImage", value, uiName);

export const setPageCanonical = (source: string, pageName: string, value: string | null, uiName?: string): string | null =>
  setPageProp(source, pageName, "canonical", value, uiName);

// --- menu block ------------------------------------------------------------

function menuBlockOf(page: Page): PageMenuMeta | undefined {
  // Last block wins on read (matching `lower-ui.ts`), so edit that one.
  let found: PageMenuMeta | undefined;
  for (const p of page.props) if (p.$type === "PageMenuMeta") found = p;
  return found;
}

/** Where a brand-new `menu { … }` block goes: after `body:` (the dominant
 *  corpus placement — examples/sales-ui.ddd), else after the last prop, else
 *  as the page's first line. */
function menuInsertionPoint(source: string, page: Page): { at: number; indent: string } | null {
  const body = page.props.find((p): p is BodyProp => p.$type === "BodyProp")?.$cstNode;
  if (body) return { at: body.end, indent: lineIndent(source, body.offset) };
  const last = page.props[page.props.length - 1]?.$cstNode;
  if (last) return { at: last.end, indent: lineIndent(source, last.offset) };
  const cst = page.$cstNode;
  const open = cst && GrammarUtils.findNodeForKeyword(cst, "{");
  if (!cst || !open) return null;
  return { at: open.end, indent: `${lineIndent(source, cst.offset)}  ` };
}

/** Set (or remove, with null) one `menu { … }` metadata entry.  `value` is
 *  expression SOURCE TEXT (`"Sales"`, `0`, `true`).  The block is created on
 *  the first set and dropped when its last entry is removed. */
export function setPageMenuMeta(
  source: string,
  pageName: string,
  key: MenuMetaKey,
  value: string | null,
  uiName?: string,
): string | null {
  const page = locate(source, pageName, uiName);
  if (!page) return null;
  const block = menuBlockOf(page);
  const index = block ? block.entries.findIndex((e) => e.name === key) : -1;
  const entry = block && index >= 0 ? block.entries[index] : undefined;

  if (value === null || value.trim() === "") {
    if (!block || !entry) return source;
    const entryCst = entry.$cstNode;
    const blockCst = block.$cstNode;
    if (!entryCst || !blockCst) return null;
    if (block.entries.length === 1) {
      // Last entry gone — drop the whole block rather than leave `menu { }`.
      return ifParses(
        applyEdits(source, [{ offset: swallowLeadingLine(source, blockCst.offset), end: blockCst.end, newText: "" }]),
      );
    }
    // Swallow the separator on whichever side keeps the remaining list valid.
    const prev = index > 0 ? block.entries[index - 1].$cstNode : undefined;
    const next = index + 1 < block.entries.length ? block.entries[index + 1].$cstNode : undefined;
    const start = prev ? prev.end : entryCst.offset;
    const end = prev ? entryCst.end : (next?.offset ?? entryCst.end);
    return ifParses(applyEdits(source, [{ offset: start, end, newText: "" }]));
  }

  const text = value.trim();
  if (!parsesAsExpr(text)) return null;

  if (entry) {
    const vcst = entry.value.$cstNode;
    if (!vcst) return null;
    return ifParses(applyEdits(source, [{ offset: vcst.offset, end: vcst.end, newText: text }]));
  }

  if (block) {
    const blockCst = block.$cstNode;
    if (!blockCst) return null;
    const last = block.entries[block.entries.length - 1]?.$cstNode;
    if (!last) {
      // Empty `menu { }` — open the entry list right after the `{`.
      const open = GrammarUtils.findNodeForKeyword(blockCst, "{");
      if (!open) return null;
      return ifParses(applyEdits(source, [{ offset: open.end, end: open.end, newText: ` ${key}: ${text} ` }]));
    }
    // Follow the block's own layout: one-per-line blocks get a new line, the
    // (corpus-canonical) single-line block gets `, key: value`.
    const multiline = blockCst.text.includes("\n");
    const newText = multiline ? `,\n${lineIndent(source, last.offset)}${key}: ${text}` : `, ${key}: ${text}`;
    return ifParses(applyEdits(source, [{ offset: last.end, end: last.end, newText }]));
  }

  const point = menuInsertionPoint(source, page);
  if (!point) return null;
  return ifParses(
    applyEdits(source, [{ offset: point.at, end: point.at, newText: `\n${point.indent}menu { ${key}: ${text} }` }]),
  );
}
