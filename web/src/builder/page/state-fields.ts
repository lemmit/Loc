import { AstUtils, GrammarUtils } from "langium";
import type { BodyProp, Expression, Model, Page, StateBlock, StateField } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { mkStateBlock, mkStateField } from "../../../../src/macros/api/index.js";
import { parseDdd } from "../parse";
import { applyEdits, nodeEditRange } from "../edit-engine";
import { baseLabel, baseSpecOf, buildTypeRef, typeText, type BaseSpec, type TypeSpec } from "../system/fields";

// ---------------------------------------------------------------------------
// Inline editing of a page's `state { … }` block from the page builder.
// Mirrors the Model builder's field editing (web/src/builder/system/fields.ts):
// each op re-parses the source, locates the page's StateBlock, and rewrites
// the SMALLEST CST range that expresses the change — one inserted field
// line, one field's own span, one field's `TypeRef`, or one field's
// `= init`. A StateField is `name: TypeRef ('=' init)?`, so we reuse
// `fields.ts`'s TypeRef helpers (`typeText`, `buildTypeRef`) directly.
//
// These ops used to reprint the whole StateBlock through the structural
// printer on every add/delete/retype/default edit — the same comment-eating,
// formatting-canonicalising path `fields.ts` moved off of. A narrow splice
// touches nothing outside the edited span, so comments and hand-spacing
// elsewhere in the block survive. The one exception stays a whole-node
// print: when a page has NO state block yet, `addStateField` synthesises a
// brand-new `StateBlock` AST node and prints IT (it has no existing CST to
// lose anything from) and inserts it before the body.
//
// Field *rename* is intentionally out of scope — a state field's name is
// referenced in the body via IR lowering, not as a Langium cross-reference, so
// renames can't be tracked safely (same reason fields.ts excludes it).
// ---------------------------------------------------------------------------

export interface StateFieldInfo {
  name: string;
  base: BaseSpec;
  baseLabel: string;
  array: boolean;
  optional: boolean;
  /** Printed default-initializer source, if the field has one. */
  init?: string;
}

const STRING_TYPE: TypeSpec = { base: { kind: "primitive", name: "string" }, array: false, optional: false };

function findPage(ast: Model, name: string): Page | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Page" && (n as Page).name === name) return n as Page;
  }
  return null;
}

function stateBlockOf(page: Page): StateBlock | undefined {
  return page.props.find((p): p is StateBlock => p.$type === "StateBlock");
}

function bodyPropOf(page: Page): BodyProp | undefined {
  return page.props.find((p): p is BodyProp => p.$type === "BodyProp");
}

function buildStateField(name: string, spec: TypeSpec, init?: Expression): StateField {
  return mkStateField({ $type: "StateField", name, type: buildTypeRef(spec), init });
}

function freshName(sb: StateBlock | undefined): string {
  const taken = new Set((sb?.fields ?? []).map((f) => f.name));
  for (let i = 1; ; i++) {
    const c = `field${i}`;
    if (!taken.has(c)) return c;
  }
}

/** Parse `text` as a standalone expression (via the page-body wrap trick used
 *  elsewhere); null if it doesn't parse. */
function parseExpr(text: string): Expression | null {
  const r = parseDdd(`system S { ui U { page P { body: ${text} } } }`);
  if (r.parserErrors.length > 0) return null;
  for (const n of AstUtils.streamAst(r.ast)) {
    if (n.$type === "BodyProp") return (n as BodyProp).expr;
  }
  return null;
}

// --- read (for the panel UI) -----------------------------------------------

export function listStateFields(page: Page): StateFieldInfo[] {
  const sb = stateBlockOf(page);
  if (!sb) return [];
  return sb.fields.map((f) => {
    const base = baseSpecOf(f.type);
    return { name: f.name, base, baseLabel: baseLabel(base), array: f.type.array, optional: f.type.optional, init: f.init?.$cstNode?.text?.trim() };
  });
}

// --- mutating ops (parse → locate → narrow splice → re-parse) --------------

/** Validate by re-parsing: return `candidate` only if it still parses. */
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

/** The shared prologue: re-parse the source and find the page.  Null on a
 *  syntactically invalid source or an unknown page. */
function locate(source: string, pageName: string): Page | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findPage(fresh.ast, pageName);
}

export function addStateField(source: string, pageName: string, spec: TypeSpec = STRING_TYPE): string | null {
  const page = locate(source, pageName);
  if (!page) return null;
  const sb = stateBlockOf(page);
  const line = `${freshName(sb)}: ${typeText(spec)}`;
  if (sb) {
    const cst = sb.$cstNode;
    if (!cst) return null;
    // Append after the last declared field, matching its indentation — the
    // in-place equivalent of pushing onto the field array.
    const last = sb.fields[sb.fields.length - 1]?.$cstNode;
    if (last) {
      const indent = lineIndent(source, last.offset);
      return ifParses(
        applyEdits(source, [{ offset: last.end, end: last.end, newText: `\n${indent}${line}` }]),
      );
    }
    // Empty block: open the first field line right after the `{`.
    const open = GrammarUtils.findNodeForKeyword(cst, "{");
    if (!open) return null;
    const indent = `${lineIndent(source, cst.offset)}  `;
    return ifParses(
      applyEdits(source, [{ offset: open.end, end: open.end, newText: `\n${indent}${line}` }]),
    );
  }
  // No state block yet — synthesise one and insert it before the body. It's a
  // brand-new node with no CST of its own, so printing it whole loses nothing.
  const body = bodyPropOf(page);
  const range = body && nodeEditRange(body);
  if (!range) return null;
  const block = mkStateBlock({ $type: "StateBlock", fields: [buildStateField(freshName(undefined), spec)] });
  return ifParses(
    applyEdits(source, [{ offset: range.offset, end: range.offset, newText: `${printStructural(block)}\n      ` }]),
  );
}

export function deleteStateField(source: string, pageName: string, index: number): string | null {
  const page = locate(source, pageName);
  const sb = page && stateBlockOf(page);
  const cst = sb?.fields[index]?.$cstNode;
  if (!sb || !cst) return null;
  // Swallow the preceding line break + indentation so no blank line is left.
  let start = cst.offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  return ifParses(applyEdits(source, [{ offset: start, end: cst.end, newText: "" }]));
}

export function retypeStateField(source: string, pageName: string, index: number, spec: TypeSpec): string | null {
  const page = locate(source, pageName);
  const sb = page && stateBlockOf(page);
  // Only the `TypeRef` span is rewritten, so a trailing `= init` on the same
  // field is untouched rather than reprinted.
  const cst = sb?.fields[index]?.type.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: typeText(spec) }]));
}

/** Set (or clear, with empty text) a field's default initializer.  Returns null
 *  if the text isn't a valid expression. */
export function setStateDefault(source: string, pageName: string, index: number, text: string): string | null {
  const page = locate(source, pageName);
  const sb = page && stateBlockOf(page);
  const field = sb?.fields[index];
  const typeCst = field?.type.$cstNode;
  if (!field || !typeCst) return null;
  const initCst = field.init?.$cstNode;
  if (text.trim() === "") {
    if (!initCst) return source;
    return ifParses(applyEdits(source, [{ offset: typeCst.end, end: initCst.end, newText: "" }]));
  }
  if (!parseExpr(text)) return null;
  const value = text.trim();
  if (initCst) {
    return ifParses(applyEdits(source, [{ offset: initCst.offset, end: initCst.end, newText: value }]));
  }
  return ifParses(applyEdits(source, [{ offset: typeCst.end, end: typeCst.end, newText: ` = ${value}` }]));
}
