import { AstUtils, GrammarUtils, type AstNode, type CstNode } from "langium";
import type {
  Area,
  MenuBlock,
  MenuLink,
  MenuSection,
  Model,
  Page,
  StateBlock,
  StateField,
  Store,
  Ui,
} from "../../../../src/language/generated/ast.js";
import { isArea, isPage } from "../../../../src/language/generated/ast.js";
import { parseDdd } from "../parse";
import { applyEdits, nodeEditRange, type TextEdit } from "../edit-engine";
import { baseLabel, baseSpecOf, typeText, type BaseSpec, type TypeSpec } from "../system/fields";

// ---------------------------------------------------------------------------
// Editing the UI DECLARATION ITSELF — the `ui { … }` members that sit BESIDE
// the pages the page builder draws: `store X [persist: …] { … }`, the
// `area X { … }` page grouping, and the ui-level `menu { section … }` sidebar.
//
// Same discipline as its siblings `page-props.ts` and `state-fields.ts`: every
// op re-parses the source (INPUT GUARD — a source the parser rejects is refused
// rather than spliced at offsets error recovery invented), locates the node,
// rewrites the SMALLEST CST range that expresses the change, then re-parses the
// candidate (OUTPUT GUARD — a result that no longer parses is discarded and the
// caller keeps the original source).  Nothing is reprinted through the
// structural printer, so comments, blank lines and hand-alignment outside the
// edited span are byte-preserved.
//
// `movePageToArea` is the one op that moves a whole declaration: it CUTS the
// page's CST span verbatim (comments inside it, and its own leading comment,
// travel along byte-for-byte) and re-inserts that exact text under the target
// area.  It deliberately does NOT re-indent — a verbatim cut is the only way to
// guarantee the page's body survives untouched.
//
// TWO REFUSALS worth knowing about, both the same rule:
//   an edit that would INVALIDATE an area-qualified `menu { link A.P }`
//   cross-reference returns null instead of silently breaking the link.
// The qualifier is part of the reference TEXT (`QualifiedPageName`, resolved by
// the area-path scope in `ddd-scope.ts`), and rewriting every referring link
// correctly is a rename-refactoring job for the LSP, not for a text splice —
// so `renameArea` and `movePageToArea` refuse on a qualified-referenced area /
// page.  Bare `link P` links are unaffected (the scope exports bare names from
// anywhere in the ui), so those moves/renames go through.
// ---------------------------------------------------------------------------

// --- shared plumbing -------------------------------------------------------

const ID_RE = /^[_a-zA-Z][\w]*$/;

/** Output guard: return `candidate` only if it still parses. */
function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

/** Extend `offset` backwards over its line's indentation and the newline before
 *  it, so a removed declaration leaves no blank line behind. */
function swallowLeadingLine(source: string, offset: number): number {
  let start = offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  return start;
}

/** Render a braced declaration at `indent`; `body` lines are indented one more
 *  step.  `head` carries the opening brace (`store Cart {`). */
function block(indent: string, head: string, body: readonly string[] = []): string {
  return [head, ...body.map((l) => `  ${l}`), "}"].join(`\n${indent}`);
}

/** One inserted member line inside a braced block.  With an `anchor` (the last
 *  existing member) the new text lands on the line after it at the SAME
 *  indentation; without one the block is empty and the text opens a first line
 *  just above the block's own `}`. */
function insertMemberEdit(
  source: string,
  ownerCst: CstNode,
  anchor: CstNode | undefined,
  render: (indent: string) => string,
): TextEdit | null {
  if (anchor) {
    const indent = lineIndent(source, anchor.offset);
    return { offset: anchor.end, end: anchor.end, newText: `\n${indent}${render(indent)}` };
  }
  const close = GrammarUtils.findNodeForKeyword(ownerCst, "}");
  if (!close) return null;
  const outer = lineIndent(source, ownerCst.offset);
  const indent = `${outer}  `;
  let start = close.offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") {
    // `}` sits on its own line — slot a whole line in above it (splicing AT the
    // newline, so the new line lands between `{` and `}` rather than after a
    // blank one).
    const at = start - 1;
    return { offset: at, end: at, newText: `\n${indent}${render(indent)}` };
  }
  // `}` shares its line with the opening — break the block open around it.
  return {
    offset: close.offset,
    end: close.offset,
    newText: `\n${indent}${render(indent)}\n${outer}`,
  };
}

/** Removal edit for a whole declaration: its own span plus the line break and
 *  indentation that preceded it. */
function removeMemberEdit(source: string, cst: CstNode): TextEdit {
  return { offset: swallowLeadingLine(source, cst.offset), end: cst.end, newText: "" };
}

function freshName(prefix: string, taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// --- locating the ui -------------------------------------------------------

function findUi(ast: Model, uiName?: string): Ui | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type !== "Ui") continue;
    const ui = n as Ui;
    // Without a name the FIRST `ui` wins, matching BuilderPane's own name-keyed
    // lookups (and `page-props.ts`'s `uiName` disambiguator).
    if (uiName === undefined || ui.name === uiName) return ui;
  }
  return null;
}

/** Shared prologue: re-parse (input guard) and find the ui.  Null on a
 *  syntactically invalid source or an unknown ui name. */
function locateUi(source: string, uiName?: string): Ui | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findUi(fresh.ast, uiName);
}

// ===========================================================================
// Stores
// ===========================================================================

/** `persist:` values the validator accepts (`loom.store-lifetime-invalid`). */
export const STORE_PERSIST_MODES = ["memory", "local", "session", "url"] as const;
export type StorePersist = (typeof STORE_PERSIST_MODES)[number];

export interface StoreInfo {
  name: string;
  /** `persist:` value, absent for the default (in-memory) store. */
  persist?: string;
  /** Fields of the store's FIRST `state { }` block (the one this module edits). */
  fieldCount: number;
  actionCount: number;
}

export interface StoreFieldInfo {
  name: string;
  base: BaseSpec;
  baseLabel: string;
  array: boolean;
  optional: boolean;
  /** Default-initializer source text, if the field has one. */
  init?: string;
}

const STRING_TYPE: TypeSpec = {
  base: { kind: "primitive", name: "string" },
  array: false,
  optional: false,
};

function storesOf(ui: Ui): Store[] {
  return ui.members.filter((m): m is Store => m.$type === "Store");
}

function findStore(ui: Ui, name: string): Store | null {
  return storesOf(ui).find((s) => s.name === name) ?? null;
}

/** A store's editable `state { }` block — the FIRST one, mirroring
 *  `state-fields.ts`'s page-side `stateBlockOf`. */
function storeStateBlock(store: Store): StateBlock | undefined {
  return store.decls.find((d): d is StateBlock => d.$type === "StateBlock");
}

function fieldInfo(f: StateField): StoreFieldInfo {
  const base = baseSpecOf(f.type);
  return {
    name: f.name,
    base,
    baseLabel: baseLabel(base),
    array: f.type.array,
    optional: f.type.optional,
    init: f.init?.$cstNode?.text?.trim(),
  };
}

/** Every `store` declared by the ui.  Null on unparseable source / unknown ui. */
export function listStores(source: string, uiName?: string): StoreInfo[] | null {
  const ui = locateUi(source, uiName);
  if (!ui) return null;
  return storesOf(ui).map((s) => ({
    name: s.name,
    persist: s.lifetime,
    fieldCount: storeStateBlock(s)?.fields.length ?? 0,
    actionCount: s.decls.filter((d) => d.$type === "ActionDecl").length,
  }));
}

/** Add an empty `store <name> { }` to the ui.  `name` defaults to a fresh
 *  `Store<N>`; an invalid identifier or a name already taken is refused. */
export function addStore(source: string, uiName: string | undefined, name?: string): string | null {
  const ui = locateUi(source, uiName);
  const uiCst = ui?.$cstNode;
  if (!ui || !uiCst) return null;
  const stores = storesOf(ui);
  const taken = new Set(stores.map((s) => s.name));
  const chosen = name?.trim() ? name.trim() : freshName("Store", taken);
  if (!ID_RE.test(chosen) || taken.has(chosen)) return null;
  // Anchor on the last store so stores stay grouped; otherwise append after the
  // ui's last member (pages, menu, …), else open the empty ui.
  const anchor = (stores[stores.length - 1] ?? ui.members[ui.members.length - 1])?.$cstNode;
  const edit = insertMemberEdit(source, uiCst, anchor, (i) => block(i, `store ${chosen} {`));
  if (!edit) return null;
  return ifParses(applyEdits(source, [edit]));
}

export function deleteStore(source: string, uiName: string | undefined, storeName: string): string | null {
  const ui = locateUi(source, uiName);
  const cst = ui ? findStore(ui, storeName)?.$cstNode : undefined;
  if (!cst) return null;
  return ifParses(applyEdits(source, [removeMemberEdit(source, cst)]));
}

/** Set (or with null remove) a store's `persist:` clause.  The clause is
 *  written right after the store's name, where the grammar puts it. */
export function setStorePersist(
  source: string,
  uiName: string | undefined,
  storeName: string,
  mode: StorePersist | null,
): string | null {
  const ui = locateUi(source, uiName);
  const store = ui ? findStore(ui, storeName) : null;
  const cst = store?.$cstNode;
  if (!store || !cst) return null;
  const nameNode = GrammarUtils.findNodeForProperty(cst, "name");
  const lifetime = GrammarUtils.findNodeForProperty(cst, "lifetime");
  if (!nameNode) return null;
  if (mode === null) {
    if (!lifetime) return source;
    // Swallow the whole ` persist: <mode>` clause, not just its value.
    return ifParses(applyEdits(source, [{ offset: nameNode.end, end: lifetime.end, newText: "" }]));
  }
  if (!(STORE_PERSIST_MODES as readonly string[]).includes(mode)) return null;
  if (lifetime) {
    return ifParses(applyEdits(source, [{ offset: lifetime.offset, end: lifetime.end, newText: mode }]));
  }
  return ifParses(
    applyEdits(source, [{ offset: nameNode.end, end: nameNode.end, newText: ` persist: ${mode}` }]),
  );
}

// --- store state fields ----------------------------------------------------
//
// `state-fields.ts`'s mutators locate their target by streaming for a `Page`
// with a given name, so they can NOT address a store's `state { }` block (a
// store is a `ui` member, not a page, and has no name-addressable page around
// it).  Rather than widen that module's locator — it is the page builder's
// state panel surface, keyed by page name throughout — the store-scoped
// equivalents live here and reuse the same `TypeSpec` vocabulary
// (`typeText` / `baseSpecOf` from `system/fields.ts`), so a field written by
// either module round-trips through the other's reader.

export function listStoreFields(
  source: string,
  uiName: string | undefined,
  storeName: string,
): StoreFieldInfo[] | null {
  const ui = locateUi(source, uiName);
  const store = ui ? findStore(ui, storeName) : null;
  if (!store) return null;
  return (storeStateBlock(store)?.fields ?? []).map(fieldInfo);
}

/** Append a fresh field to the store's `state { }` block, creating the block
 *  when the store has none. */
export function addStoreField(
  source: string,
  uiName: string | undefined,
  storeName: string,
  spec: TypeSpec = STRING_TYPE,
): string | null {
  const ui = locateUi(source, uiName);
  const store = ui ? findStore(ui, storeName) : null;
  const storeCst = store?.$cstNode;
  if (!store || !storeCst) return null;
  const sb = storeStateBlock(store);
  const line = `${freshName("field", new Set((sb?.fields ?? []).map((f) => f.name)))}: ${typeText(spec)}`;
  if (sb?.$cstNode) {
    const edit = insertMemberEdit(source, sb.$cstNode, sb.fields[sb.fields.length - 1]?.$cstNode, () => line);
    if (!edit) return null;
    return ifParses(applyEdits(source, [edit]));
  }
  // No `state { }` yet — open one as a new store declaration member.
  const edit = insertMemberEdit(
    source,
    storeCst,
    store.decls[store.decls.length - 1]?.$cstNode,
    (i) => block(i, "state {", [line]),
  );
  if (!edit) return null;
  return ifParses(applyEdits(source, [edit]));
}

export function deleteStoreField(
  source: string,
  uiName: string | undefined,
  storeName: string,
  index: number,
): string | null {
  const ui = locateUi(source, uiName);
  const store = ui ? findStore(ui, storeName) : null;
  const cst = store ? storeStateBlock(store)?.fields[index]?.$cstNode : undefined;
  if (!cst) return null;
  return ifParses(applyEdits(source, [removeMemberEdit(source, cst)]));
}

/** Rewrite ONLY a field's `TypeRef` span, so a trailing `= init` survives. */
export function retypeStoreField(
  source: string,
  uiName: string | undefined,
  storeName: string,
  index: number,
  spec: TypeSpec,
): string | null {
  const ui = locateUi(source, uiName);
  const store = ui ? findStore(ui, storeName) : null;
  const cst = store ? storeStateBlock(store)?.fields[index]?.type.$cstNode : undefined;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: typeText(spec) }]));
}

// ===========================================================================
// Areas
// ===========================================================================

export interface AreaInfo {
  name: string;
  /** Area names from the ui down to this one (`["Sales", "Orders"]`). */
  path: string[];
  /** Names of the pages declared DIRECTLY in this area. */
  pages: string[];
  areas: AreaInfo[];
}

export interface AreaTree {
  /** Pages declared directly on the ui (outside every area). */
  rootPages: string[];
  areas: AreaInfo[];
}

function directPages(members: readonly AstNode[]): string[] {
  return members.filter(isPage).map((p) => p.name);
}

function directAreas(members: readonly AstNode[]): Area[] {
  return members.filter(isArea);
}

function areaTree(members: readonly AstNode[], path: readonly string[]): AreaInfo[] {
  return directAreas(members).map((a) => {
    const here = [...path, a.name];
    return { name: a.name, path: here, pages: directPages(a.members), areas: areaTree(a.members, here) };
  });
}

/** The ui's area nesting, plus the pages that sit outside every area. */
export function listAreas(source: string, uiName?: string): AreaTree | null {
  const ui = locateUi(source, uiName);
  if (!ui) return null;
  return { rootPages: directPages(ui.members), areas: areaTree(ui.members, []) };
}

/** First area with this name, depth-first — area names are the segments of a
 *  `link A.P` qualified reference, so they are expected to be unique. */
function findArea(ui: Ui, name: string): Area | null {
  for (const n of AstUtils.streamAst(ui)) {
    if (isArea(n) && n.name === name) return n;
  }
  return null;
}

function findPageIn(ui: Ui, name: string): Page | null {
  for (const n of AstUtils.streamAst(ui)) {
    if (isPage(n) && n.name === name) return n;
  }
  return null;
}

/** Members of whatever container holds `node` (a `ui` or an `area`). */
function siblingsOf(node: Area | Page): readonly AstNode[] {
  const container = node.$container;
  return container.$type === "Ui" || container.$type === "Area" ? container.members : [];
}

/** Add an `area <name> { }` to the ui, or to `parentArea` when given. */
export function addArea(
  source: string,
  uiName: string | undefined,
  name: string,
  parentArea?: string,
): string | null {
  const ui = locateUi(source, uiName);
  if (!ui) return null;
  const chosen = name.trim();
  if (!ID_RE.test(chosen)) return null;
  const parent = parentArea === undefined ? null : findArea(ui, parentArea);
  if (parentArea !== undefined && !parent) return null;
  const members: readonly AstNode[] = parent ? parent.members : ui.members;
  if (directAreas(members).some((a) => a.name === chosen)) return null;
  const ownerCst = (parent ?? ui).$cstNode;
  if (!ownerCst) return null;
  const areas = directAreas(members);
  const anchor = (areas[areas.length - 1] ?? members[members.length - 1])?.$cstNode;
  const edit = insertMemberEdit(source, ownerCst, anchor, (i) => block(i, `area ${chosen} {`));
  if (!edit) return null;
  return ifParses(applyEdits(source, [edit]));
}

/** True when a `menu { link … }` names `pageName` (or, with `areaName`, any
 *  page) through an AREA-QUALIFIED reference whose path uses that name — the
 *  references a rename/move would silently break. */
function qualifiedMenuRefs(ui: Ui): { areas: Set<string>; pages: Set<string> } {
  const areas = new Set<string>();
  const pages = new Set<string>();
  for (const n of AstUtils.streamAst(ui)) {
    if (n.$type !== "MenuLink") continue;
    // `.ref` needs a linked document; the builders parse link-free, so the
    // reference TEXT is what we inspect (it is the qualified name verbatim).
    const text = (n as MenuLink).page?.$refText;
    if (!text) continue;
    const segments = text.split(".");
    if (segments.length < 2) continue; // a bare `link P` survives any move
    pages.add(segments[segments.length - 1]);
    for (const seg of segments.slice(0, -1)) areas.add(seg);
  }
  return { areas, pages };
}

/** Rename an area in place (a bare `ID` splice).
 *
 *  REFUSED (null) when a `menu { link <Area>.<Page> }` qualifies through this
 *  area: the area name is part of that reference's TEXT, and rewriting every
 *  referring link is a rename refactoring (LSP `references` + edit set), not a
 *  single narrow splice.  Also refused for a non-identifier or a name already
 *  taken by a sibling area. */
export function renameArea(
  source: string,
  uiName: string | undefined,
  from: string,
  to: string,
): string | null {
  const ui = locateUi(source, uiName);
  const area = ui ? findArea(ui, from) : null;
  const cst = area?.$cstNode;
  if (!ui || !area || !cst) return null;
  const next = to.trim();
  if (!ID_RE.test(next)) return null;
  if (next === from) return source;
  if (directAreas(siblingsOf(area)).some((a) => a !== area && a.name === next)) return null;
  if (qualifiedMenuRefs(ui).areas.has(from)) return null;
  const nameNode = GrammarUtils.findNodeForProperty(cst, "name");
  if (!nameNode) return null;
  return ifParses(applyEdits(source, [{ offset: nameNode.offset, end: nameNode.end, newText: next }]));
}

/** Move a page into `areaName` (or, with null, out to the ui root).
 *
 *  The page's source text is CUT VERBATIM — its own leading comment travels
 *  with it and its interior (comments, hand-spacing, the whole body) is
 *  byte-preserved; nothing is re-indented, because re-indenting means
 *  rewriting the very text this op exists to preserve.
 *
 *  REFUSED (null) when a `menu { link <Area>.<Page> }` reaches the page through
 *  an area-qualified reference — see `renameArea`. */
export function movePageToArea(
  source: string,
  uiName: string | undefined,
  pageName: string,
  areaName: string | null,
): string | null {
  const ui = locateUi(source, uiName);
  const page = ui ? findPageIn(ui, pageName) : null;
  const pageCst = page?.$cstNode;
  const uiCst = ui?.$cstNode;
  if (!ui || !page || !pageCst || !uiCst) return null;
  const target = areaName === null ? null : findArea(ui, areaName);
  if (areaName !== null && !target) return null;
  const container = page.$container;
  // Already there — nothing to do (and nothing to splice).
  if (target ? container === target : container.$type === "Ui") return source;
  if (qualifiedMenuRefs(ui).pages.has(pageName)) return null;

  const start = nodeEditRange(page, { includeLeadingComment: true })?.offset ?? pageCst.offset;
  const text = source.slice(start, pageCst.end);
  const cut = { offset: swallowLeadingLine(source, start), end: pageCst.end, newText: "" };

  const members: readonly AstNode[] = target ? target.members : ui.members;
  const ownerCst = (target ?? ui).$cstNode;
  if (!ownerCst) return null;
  const anchor = members[members.length - 1]?.$cstNode;
  const insert = insertMemberEdit(source, ownerCst, anchor, () => text);
  // The insertion point must not fall inside the span being cut.
  if (!insert || (insert.offset > cut.offset && insert.offset < cut.end)) return null;
  return ifParses(applyEdits(source, [cut, insert]));
}

// ===========================================================================
// The ui-level `menu { … }` sidebar
// ===========================================================================

export type MenuEntryInfo =
  | { kind: "page"; page: string }
  | { kind: "external"; label: string; url: string };

export interface MenuSectionInfo {
  /** The section's STRING label, delimiters stripped (as Langium reports it). */
  label: string;
  entries: MenuEntryInfo[];
}

export interface MenuInfo {
  /** False when the ui declares no `menu { … }` block at all. */
  hasMenu: boolean;
  sections: MenuSectionInfo[];
}

/** The ui's menu block — the FIRST one, matching `lower-ui.ts` (`if (!menu)`). */
function menuBlockOf(ui: Ui): MenuBlock | undefined {
  return ui.members.find((m): m is MenuBlock => m.$type === "MenuBlock");
}

function entryOf(link: MenuLink): MenuEntryInfo | null {
  if (link.page) return { kind: "page", page: link.page.$refText };
  if (link.externalLabel !== undefined && link.externalUrl !== undefined) {
    return { kind: "external", label: link.externalLabel, url: link.externalUrl };
  }
  return null;
}

/** The ui's sidebar structure.  Null on unparseable source / unknown ui. */
export function menuInfo(source: string, uiName?: string): MenuInfo | null {
  const ui = locateUi(source, uiName);
  if (!ui) return null;
  const block = menuBlockOf(ui);
  if (!block) return { hasMenu: false, sections: [] };
  return {
    hasMenu: true,
    sections: block.sections.map((s) => ({
      label: s.label,
      entries: s.links.map(entryOf).filter((e): e is MenuEntryInfo => e !== null),
    })),
  };
}

function findSection(block: MenuBlock, label: string): MenuSection | null {
  return block.sections.find((s) => s.label === label) ?? null;
}

/** Every name a `menu { link … }` may resolve to, mirroring the area-path scope
 *  built in `ddd-scope.ts`: a page's bare name plus its area-qualified one. */
export function menuLinkTargets(source: string, uiName?: string): string[] | null {
  const ui = locateUi(source, uiName);
  if (!ui) return null;
  return [...pageRefTargets(ui)];
}

function pageRefTargets(ui: Ui): Set<string> {
  const out = new Set<string>();
  const walk = (members: readonly AstNode[], path: readonly string[]): void => {
    for (const m of members) {
      if (isPage(m)) {
        out.add(m.name);
        if (path.length > 0) out.add([...path, m.name].join("."));
      } else if (isArea(m)) {
        walk(m.members, [...path, m.name]);
      }
    }
  };
  walk(ui.members, []);
  return out;
}

/** Add a `section "<label>" { }`, creating the `menu { … }` block on the first
 *  one.  A duplicate label is refused — sections are addressed BY label here,
 *  so two of them would make every later op ambiguous. */
export function addMenuSection(source: string, uiName: string | undefined, label: string): string | null {
  const ui = locateUi(source, uiName);
  const uiCst = ui?.$cstNode;
  if (!ui || !uiCst) return null;
  const text = label.trim();
  if (text === "") return null;
  const block0 = menuBlockOf(ui);
  if (block0 && findSection(block0, text)) return null;
  const head = `section ${JSON.stringify(text)} {`;
  if (block0?.$cstNode) {
    const anchor = block0.sections[block0.sections.length - 1]?.$cstNode;
    const edit = insertMemberEdit(source, block0.$cstNode, anchor, (i) => block(i, head));
    if (!edit) return null;
    return ifParses(applyEdits(source, [edit]));
  }
  const edit = insertMemberEdit(source, uiCst, ui.members[ui.members.length - 1]?.$cstNode, (i) =>
    block(i, "menu {", [head, "}"]),
  );
  if (!edit) return null;
  return ifParses(applyEdits(source, [edit]));
}

/** Delete a section; the whole `menu { … }` block goes with the last one (the
 *  mirror of creating it with the first — an empty `menu { }` is noise). */
export function deleteMenuSection(source: string, uiName: string | undefined, label: string): string | null {
  const ui = locateUi(source, uiName);
  const block0 = ui ? menuBlockOf(ui) : undefined;
  const section = block0 ? findSection(block0, label) : null;
  if (!block0 || !section) return null;
  const cst = block0.sections.length === 1 ? block0.$cstNode : section.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [removeMemberEdit(source, cst)]));
}

/** A link to add: an in-ui page (bare or area-qualified name) or an external
 *  label → url pair. */
export type MenuLinkTarget = { page: string } | { label: string; url: string };

/** Append a link to a section.  A page target must name a page this ui's menu
 *  scope can resolve (bare name, or `Area.Page` path) — an unknown one is
 *  refused rather than written as a dangling reference. */
export function addMenuLink(
  source: string,
  uiName: string | undefined,
  sectionLabel: string,
  target: MenuLinkTarget,
): string | null {
  const ui = locateUi(source, uiName);
  const block0 = ui ? menuBlockOf(ui) : undefined;
  const section = block0 ? findSection(block0, sectionLabel) : null;
  const sectionCst = section?.$cstNode;
  if (!ui || !section || !sectionCst) return null;
  let line: string;
  if ("page" in target) {
    const name = target.page.trim();
    if (!pageRefTargets(ui).has(name)) return null;
    line = `link ${name}`;
  } else {
    const label = target.label.trim();
    const url = target.url.trim();
    if (label === "" || url === "") return null;
    line = `link ${JSON.stringify(label)} -> ${JSON.stringify(url)}`;
  }
  const last = section.links[section.links.length - 1]?.$cstNode;
  if (last) {
    // Separate with a comma, the corpus style (`link A,` / `link B`); the
    // grammar's own separator is optional, so a trailing one still parses.
    const indent = lineIndent(source, last.offset);
    return ifParses(
      applyEdits(source, [{ offset: last.end, end: last.end, newText: `,\n${indent}${line}` }]),
    );
  }
  const edit = insertMemberEdit(source, sectionCst, undefined, () => line);
  if (!edit) return null;
  return ifParses(applyEdits(source, [edit]));
}

/** Delete the `index`-th link of a section, swallowing whichever comma keeps
 *  the remaining list valid. */
export function deleteMenuLink(
  source: string,
  uiName: string | undefined,
  sectionLabel: string,
  index: number,
): string | null {
  const ui = locateUi(source, uiName);
  const block0 = ui ? menuBlockOf(ui) : undefined;
  const section = block0 ? findSection(block0, sectionLabel) : null;
  const cst = section?.links[index]?.$cstNode;
  if (!section || !cst) return null;
  if (section.links.length === 1) {
    return ifParses(applyEdits(source, [removeMemberEdit(source, cst)]));
  }
  const prev = index > 0 ? section.links[index - 1].$cstNode : undefined;
  const next = index + 1 < section.links.length ? section.links[index + 1].$cstNode : undefined;
  const offset = prev ? prev.end : cst.offset;
  const end = prev ? cst.end : (next?.offset ?? cst.end);
  return ifParses(applyEdits(source, [{ offset, end, newText: "" }]));
}
