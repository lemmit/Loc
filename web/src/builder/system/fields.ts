import { AstUtils, GrammarUtils, type AstNode } from "langium";
import type {
  Aggregate,
  EnumDecl,
  EventDecl,
  Model,
  Property,
  TypeRef,
  ValueObject,
} from "../../../../src/language/generated/ast.js";
// The playground re-exports the canonical primitive set the toolchain
// declares — keeps the field-builder's type picker in lockstep with
// the IR so a new primitive (e.g. `money` in #498) shows up here
// automatically.
import { PRIMITIVES, type PrimitiveName } from "../../../../src/ir/types/loom-ir.js";
import {
  mkIdType,
  mkNamedType,
  mkPrimitiveType,
  mkTypeRef,
} from "../../../../src/macros/api/index.js";
import { parseDdd } from "../parse";
import { applyEdits, ifParses } from "../edit-engine";
import type { NodeKind } from "./model";

export { PRIMITIVES, type PrimitiveName };

// ---------------------------------------------------------------------------
// Inline field editing for the Model builder's Property-bearing constructs
// (aggregate / value object / event).  Each op re-parses the current source,
// finds the construct, and rewrites the SMALLEST CST range that expresses the
// change: one inserted member line, one Property's own span, one field's
// `TypeRef`.
//
// The ops used to reprint the whole construct through the structural printer
// instead.  That printer has no comment handling, so every `//` / `/* */`
// inside the aggregate was deleted and its formatting re-canonicalised on any
// field edit — the exact loss `edit-engine.ts` promises never happens.  A
// narrow splice touches nothing outside the edited span, so comments, blank
// lines and hand-spacing survive byte-for-byte; retyping in particular now
// preserves everything AFTER the type on the same field (`= default`,
// `check`, `sensitive(...)`, `mask unless`, the access modifier), which the
// reprint round-tripped only by luck.  Every result is re-parsed before it is
// returned (`ifParses`), so a malformed edit reports `null` rather than
// committing broken source.
//
// Field *rename* is intentionally out of scope — field-name references in
// expressions/views are resolved during IR lowering, not as Langium
// cross-references, so they can't be safely tracked here.
// ---------------------------------------------------------------------------

export type BaseSpec =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "id"; target: string }
  | { kind: "named"; target: string };

export interface TypeSpec {
  base: BaseSpec;
  array: boolean;
  optional: boolean;
}

export interface FieldInfo {
  name: string;
  base: BaseSpec;
  baseLabel: string;
  array: boolean;
  optional: boolean;
}

export interface TypeOption {
  label: string;
  base: BaseSpec;
}

const FIELD_KINDS: NodeKind[] = ["aggregate", "valueobject", "event"];
export const isFieldKind = (kind: NodeKind): boolean => FIELD_KINDS.includes(kind);

const KIND_TO_TYPE: Partial<Record<NodeKind, string>> = {
  aggregate: "Aggregate",
  valueobject: "ValueObject",
  event: "EventDecl",
};

function findConstruct(ast: Model, kind: NodeKind, name: string): AstNode | null {
  const wantType = KIND_TO_TYPE[kind];
  if (!wantType) return null;
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === wantType && (n as { name?: unknown }).name === name) return n;
  }
  return null;
}

/** The property nodes of a construct, paired with where they live so we can
 *  mutate the backing array.  Events keep them in `fields`; aggregates and
 *  value objects keep them in `members` interleaved with other member kinds —
 *  so `container` is the heterogeneous backing array (typed as `AstNode[]`
 *  to span both member-array shapes), and `list` is the `Property`-only view. */
function propertyList(node: AstNode): { list: Property[]; container: AstNode[] } {
  if (node.$type === "EventDecl") {
    const fields = (node as EventDecl).fields;
    return { list: fields, container: fields };
  }
  const members = (node as Aggregate | ValueObject).members as AstNode[];
  const list = members.filter((m): m is Property => m.$type === "Property");
  return { list, container: members };
}

export function baseLabel(base: BaseSpec): string {
  switch (base.kind) {
    case "primitive":
      return base.name;
    case "id":
      return `${base.target} id`;
    case "named":
      return base.target;
  }
}

export function baseSpecOf(type: TypeRef): BaseSpec {
  const base = type.base;
  switch (base.$type) {
    case "PrimitiveType":
      return { kind: "primitive", name: base.name };
    case "IdType":
      return { kind: "id", target: base.target.$refText };
    case "NamedType":
      return { kind: "named", target: base.target.$refText };
    default:
      return { kind: "named", target: "" };
  }
}

/** The `.ddd` source text for a picked type — `baseLabel` plus the `[]` / `?`
 *  suffixes, in the grammar's `base ('[]')? ('?')?` order.  This is what the
 *  narrow splices write; `buildTypeRef` is the AST twin, kept for the page
 *  builder's state fields (which still build nodes). */
export function typeText(spec: TypeSpec): string {
  // `duration` is expression-only — same guard, same reason as `buildTypeRef`.
  if (spec.base.kind === "primitive" && spec.base.name === "duration") {
    throw new Error("'duration' is not a storable primitive type (expression-only)");
  }
  return `${baseLabel(spec.base)}${spec.array ? "[]" : ""}${spec.optional ? "?" : ""}`;
}

export function buildTypeRef(spec: TypeSpec): TypeRef {
  let base: TypeRef["base"];
  switch (spec.base.kind) {
    case "primitive": {
      // `duration` is expression-only (A5 temporal): it is deliberately
      // absent from the grammar's `PrimitiveType` rule, so it can never be
      // a structural base type — only the `days/hours/minutes/months`
      // constructors and temporal arithmetic produce it.  The IR-level
      // `PrimitiveName` union carries it, so narrow it out here before
      // building the grammar node.
      if (spec.base.name === "duration") {
        throw new Error("'duration' is not a storable primitive type (expression-only)");
      }
      base = mkPrimitiveType({ $type: "PrimitiveType", name: spec.base.name });
      break;
    }
    case "id":
      base = mkIdType({ $type: "IdType", target: { $refText: spec.base.target, ref: undefined } });
      break;
    case "named":
      base = mkNamedType({
        $type: "NamedType",
        target: { $refText: spec.base.target, ref: undefined },
      });
      break;
  }
  return mkTypeRef({
    $type: "TypeRef",
    base,
    ctors: [],
    alternatives: [],
    array: spec.array,
    optional: spec.optional,
  });
}

// --- read helpers (for the inspector UI) -----------------------------------

export function listFields(node: AstNode): FieldInfo[] {
  // Read path: the panes re-read the live source mid-keystroke, so a property
  // whose `type` didn't parse is skipped rather than dereferenced (the same
  // recovered-AST guard `listStateFields` carries).
  return propertyList(node).list.flatMap((p) => {
    if (!p.type) return [];
    const base = baseSpecOf(p.type);
    return [{ name: p.name, base, baseLabel: baseLabel(base), array: p.type.array, optional: p.type.optional }];
  });
}

/** Type options for the Select: the primitives, plus `Agg id` for each
 *  aggregate and a named type for each value object / enum. */
export function availableTypes(ast: Model): TypeOption[] {
  const out: TypeOption[] = PRIMITIVES.map((name) => ({ label: name, base: { kind: "primitive", name } }));
  const seen = new Set(out.map((o) => o.label));
  const add = (opt: TypeOption): void => {
    if (!seen.has(opt.label)) {
      seen.add(opt.label);
      out.push(opt);
    }
  };
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate") {
      const name = (n as Aggregate).name;
      add({ label: `${name} id`, base: { kind: "id", target: name } });
    } else if (n.$type === "ValueObject") {
      const name = (n as ValueObject).name;
      add({ label: name, base: { kind: "named", target: name } });
    } else if (n.$type === "EnumDecl") {
      const name = (n as EnumDecl).name;
      add({ label: name, base: { kind: "named", target: name } });
    }
  }
  return out;
}

// --- mutating ops (parse → locate → narrow splice → re-parse) --------------

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

/** The shared prologue: re-parse the source and find the construct.  Null on a
 *  syntactically invalid source (an edit on top of broken text would splice at
 *  offsets the recovery parser invented) or an unknown construct. */
function locate(source: string, kind: NodeKind, name: string): AstNode | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findConstruct(fresh.ast, kind, name);
}

export function addField(
  source: string,
  kind: NodeKind,
  name: string,
  fieldName: string,
  type: TypeSpec,
): string | null {
  const node = locate(source, kind, name);
  const cst = node?.$cstNode;
  if (!node || !cst) return null;
  const line = `${fieldName}: ${typeText(type)}`;
  // Append after the last declared member, matching its indentation — the
  // in-place equivalent of pushing onto the member array.  Anything after it
  // (a trailing comment, blank lines before the `}`) is left where it is.
  const members = propertyList(node).container;
  const last = members[members.length - 1]?.$cstNode;
  if (last) {
    const indent = lineIndent(source, last.offset);
    return ifParses(
      applyEdits(source, [{ offset: last.end, end: last.end, newText: `\n${indent}${line}` }]),
    );
  }
  // Empty body: open the first member line right after the `{`.
  const open = GrammarUtils.findNodeForKeyword(cst, "{");
  if (!open) return null;
  const indent = `${lineIndent(source, cst.offset)}  `;
  return ifParses(
    applyEdits(source, [{ offset: open.end, end: open.end, newText: `\n${indent}${line}` }]),
  );
}

export function deleteField(source: string, kind: NodeKind, name: string, index: number): string | null {
  const node = locate(source, kind, name);
  if (!node) return null;
  const cst = propertyList(node).list[index]?.$cstNode;
  if (!cst) return null;
  // Swallow the preceding line break + indentation so no blank line is left…
  let start = cst.offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  // …and a same-line trailing comma, since an event's fields may be
  // comma-separated (`event E { a: int, b: string }`).
  let end = cst.end;
  let i = end;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  if (source[i] === ",") end = i + 1;
  return ifParses(applyEdits(source, [{ offset: start, end, newText: "" }]));
}

export function retypeField(
  source: string,
  kind: NodeKind,
  name: string,
  index: number,
  type: TypeSpec,
): string | null {
  const node = locate(source, kind, name);
  if (!node) return null;
  // Only the `TypeRef` span is rewritten, so everything the grammar allows
  // after it on the same field — `= default`, `check … message "…"`,
  // `sensitive(…)`, `provenanced`, the access modifier / `mask unless` — is
  // untouched rather than reprinted.
  const cst = propertyList(node).list[index]?.type.$cstNode;
  if (!cst) return null;
  return ifParses(
    applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: typeText(type) }]),
  );
}

/** A field name not already used by the construct's fields. */
export function freshFieldName(node: AstNode): string {
  const taken = new Set(propertyList(node).list.map((p) => p.name));
  for (let i = 1; ; i++) {
    const candidate = `field${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
