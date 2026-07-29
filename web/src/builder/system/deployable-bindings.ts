import { AstUtils, CstUtils, GrammarUtils, type AstNode, type CstNode } from "langium";
import type { Deployable, Model } from "../../../../src/language/generated/ast.js";
import { parseDdd } from "../parse";
import { applyEdits, ifParses } from "../edit-engine";

// ---------------------------------------------------------------------------
// Deployable composition bindings — the multi-valued / single references a
// deployable carries: `contexts:`, `dataSources:`, `serves:`, `targets:`, and
// the sugar `ui:`.
//
// Each setter is a NARROW SPLICE over the clause it edits: rewrite just the ref
// tokens, drop just the clause's own line, or append one new clause line before
// the closing `}`.  Reprinting the whole `deployable { … }` (the path these
// setters used to take) ran it through the structural printer, which has no
// comment handling — so every comment inside the deployable was deleted on any
// binding edit, and the clause order was re-canonicalised.
//
// The advanced `ui: W { … }` compose form stays the text editor's job —
// `uiKind` reports it so the UI hides the picker — but `setDeployableUi` is now
// non-destructive if it is called anyway: it retargets the ui NAME in place and
// leaves the param-binding block alone, and refuses (null) to clear it.
// ---------------------------------------------------------------------------

function nodeNames(ast: Model, type: string): string[] {
  const out: string[] = [];
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === type) {
      const name = (n as { name?: unknown }).name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

export const subdomainNames = (ast: Model): string[] => nodeNames(ast, "Subdomain");
export const boundedContextNames = (ast: Model): string[] => nodeNames(ast, "BoundedContext");
export const dataSourceNames = (ast: Model): string[] => nodeNames(ast, "Resource");
export const apiNames = (ast: Model): string[] => nodeNames(ast, "Api");
export const uiNames = (ast: Model): string[] => nodeNames(ast, "Ui");
export const deployableNames = (ast: Model): string[] => nodeNames(ast, "Deployable");

function asDeployable(node: AstNode): Deployable | null {
  return node.$type === "Deployable" ? (node as Deployable) : null;
}

// --- read helpers ----------------------------------------------------------

export function deployableContexts(node: AstNode): string[] {
  return asDeployable(node)?.contextRefs.map((b) => b.$refText) ?? [];
}
export function deployableDataSources(node: AstNode): string[] {
  return asDeployable(node)?.dataSourceRefs.map((b) => b.$refText) ?? [];
}
export function deployableServes(node: AstNode): string[] {
  return asDeployable(node)?.serves.map((s) => s.$refText) ?? [];
}
export function deployableTargets(node: AstNode): string | null {
  return asDeployable(node)?.targets?.$refText ?? null;
}
/** "sugar" → editable single ui ref; "compose" → advanced (text-only);
 *  "none" → no ui binding. */
export function uiKind(node: AstNode): "sugar" | "compose" | "none" {
  const d = asDeployable(node);
  if (!d) return "none";
  if (d.uiCompose) return "compose";
  return d.uiSugar ? "sugar" : "none";
}
export function deployableUi(node: AstNode): string | null {
  // `ref` is absent on a partially-recovered AST (`ui ` with nothing after it),
  // so the whole chain stays optional.
  return asDeployable(node)?.uiSugar?.ref?.$refText ?? null;
}

// --- mutating ops (parse → locate → narrow splice → re-parse) --------------

const COMMENT_RULES = ["ML_COMMENT", "SL_COMMENT"];

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

/** Extend a clause-removal start back over its line's indentation and the
 *  newline before it, so dropping the clause leaves no blank line. */
function swallowLine(source: string, offset: number): number {
  let start = offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  return start > 0 && source[start - 1] === "\n" ? start - 1 : offset;
}

/** Extend a clause-removal end forward over the optional trailing `,`. */
function swallowComma(source: string, end: number): number {
  let i = end;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source[i] === "," ? i + 1 : end;
}

/** The last real token before the deployable's closing `}` — the anchor a new
 *  clause line is appended after, so a trailing comment stays trailing. */
function lastClauseToken(cst: CstNode): CstNode | null {
  let last: CstNode | null = null;
  for (const n of CstUtils.flattenCst(cst)) {
    if (n.end >= cst.end) break;
    if (CstUtils.isCommentNode(n, COMMENT_RULES)) continue;
    last = n;
  }
  return last;
}

/** The clause keyword introducing the ref(s) starting at `before`.  Clause
 *  keywords are unique within a deployable body, so the nearest preceding one
 *  is this clause's. */
function keywordBefore(cst: CstNode, keyword: string, before: number): CstNode | null {
  let best: CstNode | null = null;
  for (const n of GrammarUtils.findNodesForKeyword(cst, keyword)) {
    if (n.offset < before) best = n;
  }
  return best;
}

function insertClause(source: string, cst: CstNode, text: string): string | null {
  const anchor = lastClauseToken(cst);
  if (!anchor) return null;
  const indent = lineIndent(source, anchor.offset);
  return ifParses(
    applyEdits(source, [{ offset: anchor.end, end: anchor.end, newText: `\n${indent}${text}` }]),
  );
}

function locate(source: string, name: string): Deployable | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  for (const n of AstUtils.streamAst(fresh.ast)) {
    if (n.$type === "Deployable" && (n as Deployable).name === name) return n as Deployable;
  }
  return null;
}

interface RefListClause {
  /** The Deployable property holding the refs. */
  prop: "contextRefs" | "dataSourceRefs" | "serves";
  keyword: string;
  /** `contexts:`/`dataSources:` are bracketed; `serves:` is a bare list. */
  bracketed: boolean;
}

function setRefList(source: string, name: string, clause: RefListClause, values: string[]): string | null {
  const d = locate(source, name);
  const cst = d?.$cstNode;
  if (!d || !cst) return null;
  const refs = [...GrammarUtils.findNodesForProperty(cst, clause.prop)];
  const joined = values.join(", ");
  if (refs.length === 0) {
    if (values.length === 0) return source;
    return insertClause(source, cst, clause.bracketed ? `${clause.keyword}: [${joined}]` : `${clause.keyword}: ${joined}`);
  }
  const first = refs[0];
  const last = refs[refs.length - 1];
  if (values.length > 0) {
    // Rewrite only the ref tokens — brackets, spacing, and anything else in
    // the deployable body stay exactly as the author wrote them.
    return ifParses(applyEdits(source, [{ offset: first.offset, end: last.end, newText: joined }]));
  }
  // Emptying the list drops the clause: keyword through the closing `]` (or
  // the last ref), plus its optional trailing comma and its own line break.
  const kw = keywordBefore(cst, clause.keyword, first.offset);
  if (!kw) return null;
  let end = last.end;
  if (clause.bracketed) {
    let close: CstNode | undefined;
    for (const n of GrammarUtils.findNodesForKeyword(cst, "]")) {
      if (n.offset >= last.end) { close = n; break; }
    }
    if (!close) return null;
    end = close.end;
  }
  return ifParses(
    applyEdits(source, [
      { offset: swallowLine(source, kw.offset), end: swallowComma(source, end), newText: "" },
    ]),
  );
}

export function setDeployableContexts(source: string, name: string, contexts: string[]): string | null {
  return setRefList(source, name, { prop: "contextRefs", keyword: "contexts", bracketed: true }, contexts);
}
export function setDeployableDataSources(source: string, name: string, dataSources: string[]): string | null {
  return setRefList(source, name, { prop: "dataSourceRefs", keyword: "dataSources", bracketed: true }, dataSources);
}
export function setDeployableServes(source: string, name: string, apis: string[]): string | null {
  return setRefList(source, name, { prop: "serves", keyword: "serves", bracketed: false }, apis);
}

export function setDeployableTargets(source: string, name: string, target: string | null): string | null {
  const d = locate(source, name);
  const cst = d?.$cstNode;
  if (!d || !cst) return null;
  const node = GrammarUtils.findNodeForProperty(cst, "targets");
  if (target) {
    if (!node) return insertClause(source, cst, `targets: ${target}`);
    return ifParses(applyEdits(source, [{ offset: node.offset, end: node.end, newText: target }]));
  }
  if (!node) return source;
  const kw = keywordBefore(cst, "targets", node.offset);
  if (!kw) return null;
  return ifParses(
    applyEdits(source, [
      { offset: swallowLine(source, kw.offset), end: swallowComma(source, node.end), newText: "" },
    ]),
  );
}

export function setDeployableUi(source: string, name: string, ui: string | null): string | null {
  const d = locate(source, name);
  const cst = d?.$cstNode;
  if (!d || !cst) return null;
  // `ui: W { … }` carries per-param bindings the picker cannot express.  It is
  // retargeted by rewriting the ui NAME only — the block survives — and a
  // request to CLEAR it is refused rather than silently throwing the bindings
  // away (the text editor owns that edit).
  const compose = d.uiCompose?.$cstNode;
  if (compose) {
    if (!ui) return null;
    const node = GrammarUtils.findNodeForProperty(compose, "ref");
    if (!node) return null;
    return ifParses(applyEdits(source, [{ offset: node.offset, end: node.end, newText: ui }]));
  }
  const sugar = d.uiSugar?.$cstNode;
  if (sugar) {
    if (!ui) {
      return ifParses(
        applyEdits(source, [
          { offset: swallowLine(source, sugar.offset), end: swallowComma(source, sugar.end), newText: "" },
        ]),
      );
    }
    const node = GrammarUtils.findNodeForProperty(sugar, "ref");
    if (!node) return null;
    return ifParses(applyEdits(source, [{ offset: node.offset, end: node.end, newText: ui }]));
  }
  return ui ? insertClause(source, cst, `ui: ${ui}`) : source;
}
