import { AstUtils } from "langium";
import type { BodyProp, Expression, Model, Page, StateBlock, StateField } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { mkStateBlock, mkStateField } from "../../../../src/macros/api/index.js";
import { parseDdd } from "../parse";
import { applyEdits, nodeEditRange, spliceNode } from "../edit-engine";
import { baseLabel, baseSpecOf, buildTypeRef, type BaseSpec, type TypeSpec } from "../system/fields";

// ---------------------------------------------------------------------------
// Inline editing of a page's `state { … }` block from the page builder.  Mirrors
// the Model builder's field editing (web/src/builder/system/fields.ts): each op
// re-parses the source, finds the page, mutates its StateBlock in memory,
// reprints with the structural printer, and splices over the block's CST range.
// A StateField is `name: TypeRef ('=' init)?`, so we reuse fields.ts's TypeRef
// helpers and add a `default` (init) editor.
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

// --- mutating ops (parse → mutate → reprint → splice) ----------------------

function commit(source: string, pageName: string, mutate: (page: Page) => string | null): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  const page = findPage(fresh.ast, pageName);
  if (!page) return null;
  return mutate(page);
}

/** Reprint the page's existing StateBlock over its CST range. */
function spliceState(source: string, sb: StateBlock): string {
  return spliceNode(source, sb, printStructural(sb));
}

export function addStateField(source: string, pageName: string, spec: TypeSpec = STRING_TYPE): string | null {
  return commit(source, pageName, (page) => {
    const sb = stateBlockOf(page);
    if (sb) {
      sb.fields.push(buildStateField(freshName(sb), spec));
      return spliceState(source, sb);
    }
    // No state block yet — synthesise one and insert it before the body.
    const body = bodyPropOf(page);
    const range = body && nodeEditRange(body);
    if (!range) return null;
    const block = mkStateBlock({ $type: "StateBlock", fields: [buildStateField(freshName(undefined), spec)] });
    return applyEdits(source, [{ offset: range.offset, end: range.offset, newText: `${printStructural(block)}\n      ` }]);
  });
}

export function deleteStateField(source: string, pageName: string, index: number): string | null {
  return commit(source, pageName, (page) => {
    const sb = stateBlockOf(page);
    if (!sb || !sb.fields[index]) return null;
    sb.fields.splice(index, 1);
    return spliceState(source, sb);
  });
}

export function retypeStateField(source: string, pageName: string, index: number, spec: TypeSpec): string | null {
  return commit(source, pageName, (page) => {
    const sb = stateBlockOf(page);
    const field = sb?.fields[index];
    if (!sb || !field) return null;
    field.type = buildTypeRef(spec);
    return spliceState(source, sb);
  });
}

/** Set (or clear, with empty text) a field's default initializer.  Returns null
 *  if the text isn't a valid expression. */
export function setStateDefault(source: string, pageName: string, index: number, text: string): string | null {
  return commit(source, pageName, (page) => {
    const sb = stateBlockOf(page);
    const field = sb?.fields[index];
    if (!sb || !field) return null;
    if (text.trim() === "") {
      field.init = undefined;
    } else {
      const expr = parseExpr(text);
      if (!expr) return null;
      field.init = expr;
    }
    return spliceState(source, sb);
  });
}
