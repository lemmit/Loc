import { AstUtils, CstUtils, GrammarUtils, type AstNode, type CstNode } from "langium";
import type { Deployable, Model, Storage } from "../../../../src/language/generated/ast.js";
import { parseDdd } from "../parse";
import { applyEdits, ifParses } from "../edit-engine";

// ---------------------------------------------------------------------------
// Scalar property editing for the infra constructs (storage / deployable):
// `storage { type: … }` and `deployable { platform: …, port: … }`.
//
// Each setter is a NARROW SPLICE over the clause it edits: rewrite just the
// value token, or — for `port`, which is optional in the grammar — insert a
// new `port: N` line or drop the existing one entirely.  These used to
// reprint the whole `storage { … }` / `deployable { … }` through the
// structural printer (the path `fields.ts` / `find-params.ts` /
// `deployable-bindings.ts` moved off of for the same reason): that printer
// has no comment handling, so every comment inside the construct was deleted
// on any scalar edit, and clause order was re-canonicalised.  `type` and
// `platform` are mandatory clauses (always present on a parsed node), so
// only `port` needs the insert/drop branches.
// ---------------------------------------------------------------------------

export const STORAGE_TYPES = [
  "postgres", "mysql", "sqlite", "inMemory", "redis", "elastic", "meilisearch", "kafka", "clickhouse", "bigquery",
];
export const PLATFORMS = ["node", "dotnet", "react", "static", "elixir"];

function findByName(ast: Model, type: string, name: string): AstNode | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === type && (n as { name?: unknown }).name === name) return n;
  }
  return null;
}

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

const COMMENT_RULES = ["ML_COMMENT", "SL_COMMENT"];

/** The last real token before the construct's closing `}` — the anchor a new
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

/** The shared prologue: re-parse the source and find the named node of
 *  `type`.  Null on a syntactically invalid source or an unknown node. */
function locate(source: string, type: string, name: string): AstNode | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findByName(fresh.ast, type, name);
}

// --- storage ---------------------------------------------------------------

export function storageType(node: AstNode): string | undefined {
  return node.$type === "Storage" ? (node as Storage).type : undefined;
}

export function setStorageType(source: string, name: string, type: string): string | null {
  const node = locate(source, "Storage", name);
  const cst = node?.$cstNode;
  if (!node || !cst) return null;
  const value = GrammarUtils.findNodeForProperty(cst, "type");
  if (!value) return null;
  return ifParses(applyEdits(source, [{ offset: value.offset, end: value.end, newText: type }]));
}

// --- deployable --------------------------------------------------------

export function deployablePlatform(node: AstNode): string | undefined {
  return node.$type === "Deployable" ? (node as Deployable).platform : undefined;
}

export function deployablePort(node: AstNode): number | undefined {
  return node.$type === "Deployable" ? (node as Deployable).port : undefined;
}

export function setDeployablePlatform(source: string, name: string, platform: string): string | null {
  const node = locate(source, "Deployable", name);
  const cst = node?.$cstNode;
  if (!node || !cst) return null;
  const value = GrammarUtils.findNodeForProperty(cst, "platform");
  if (!value) return null;
  return ifParses(applyEdits(source, [{ offset: value.offset, end: value.end, newText: platform }]));
}

export function setDeployablePort(source: string, name: string, port: number | undefined): string | null {
  const node = locate(source, "Deployable", name);
  const cst = node?.$cstNode;
  if (!node || !cst) return null;
  const value = GrammarUtils.findNodeForProperty(cst, "port");
  if (port !== undefined) {
    if (!value) return insertClause(source, cst, `port: ${port}`);
    return ifParses(applyEdits(source, [{ offset: value.offset, end: value.end, newText: String(port) }]));
  }
  if (!value) return source;
  const kw = keywordBefore(cst, "port", value.offset);
  if (!kw) return null;
  return ifParses(
    applyEdits(source, [
      { offset: swallowLine(source, kw.offset), end: swallowComma(source, value.end), newText: "" },
    ]),
  );
}
