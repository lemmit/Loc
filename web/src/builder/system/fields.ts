import { AstUtils, GrammarUtils, type AstNode, type CstNode } from "langium";
import type {
  Aggregate,
  EnumDecl,
  EventDecl,
  FieldAccess,
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
import { IDENTIFIER } from "./rename";
import type { NodeKind } from "./model";

export { PRIMITIVES, type PrimitiveName };
// The grammar's own access-modifier union, re-exported so the inspector and the
// tests name it without reaching into the generated AST module.
export type { FieldAccess };

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

/** The five `FieldAccess` keywords, in the grammar's own order.  Absent = the
 *  `editable` default, which has no keyword to write. */
export const FIELD_ACCESS: readonly FieldAccess[] = [
  "immutable",
  "managed",
  "token",
  "internal",
  "secret",
] as const;

/** A field's modifier state, read back as SOURCE TEXT (not re-printed AST) so
 *  the inspector shows exactly what the author wrote and a round-trip through
 *  the editors is a no-op. */
export interface FieldModifiers {
  /** `= <expr>` — the expression source, without the `=`. */
  default: string | null;
  /** `check <expr>` — the predicate source, without the `check`. */
  check: string | null;
  /** The check's `message "…"` payload, delimiters already stripped. */
  checkMessage: string | null;
  /** `mask unless <expr>` — the predicate source, without the keywords. */
  maskUnless: string | null;
  access: FieldAccess | null;
  provenanced: boolean;
  /** `sensitive(a, b)` tags; null when the clause is absent. */
  sensitivity: string[] | null;
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

/** Per-field modifier state, positionally parallel to `listFields`. */
export function listFieldModifiers(node: AstNode): FieldModifiers[] {
  return propertyList(node).list.map((p) => ({
    default: p.default?.$cstNode?.text ?? null,
    check: p.check?.$cstNode?.text ?? null,
    checkMessage: p.message ?? null,
    maskUnless: p.maskUnless?.$cstNode?.text ?? null,
    access: p.access ?? null,
    provenanced: p.provenanced,
    sensitivity: p.sensitivity ? [...p.sensitivity.tags] : null,
  }));
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

// --- property modifiers ----------------------------------------------------
//
// The grammar (`Property`, ddd.langium) fixes ONE order for the clauses that
// carry expression content:
//
//   name ':' TypeRef  (provenanced | sensitive(…) | access)*  ('=' default)?
//                     ('check' expr ('message' STRING)?)?  ('mask' 'unless' expr)?
//
// The three flag-like modifiers parse in any order among themselves, but the
// group as a whole must precede `= default` — `x: int = 1 secret` is a parse
// ERROR (an access keyword doubles as an identifier, so it would be swallowed
// by the default expression).  So every "add" below splices at the anchor its
// clause must follow, never simply at the end of the property:
//
//   a new flag / a new `= default`  →  end of the flag region (`spans.flags`)
//   a new `check`                   →  end of the default     (`spans.afterDefault`)
//   a new `mask unless`             →  end of the check       (`spans.afterCheck`)
//
// Each anchor falls back to the previous one when its clause is absent, so the
// modifiers COMPOSE in any application order.  A "replace" rewrites exactly the
// existing clause's span (keyword included); a removal additionally swallows the
// one preceding space so no double space is left behind.  Passing `null` (or an
// empty string) removes; removing an absent clause is a no-op that returns the
// source unchanged.  Expression text is validated by the output re-parse alone —
// there is no separate expression parser here.

interface PropSpans {
  prop: Property;
  cst: CstNode;
  /** After the type + every flag modifier — where a flag or `= default` goes. */
  flags: number;
  /** After the default when present, else `flags` — where `check` goes. */
  afterDefault: number;
  /** After the check (+ its message) when present, else `afterDefault`. */
  afterCheck: number;
}

function propSpans(node: AstNode | null, index: number): PropSpans | null {
  if (!node) return null;
  const prop = propertyList(node).list[index];
  const cst = prop?.$cstNode;
  const typeCst = prop?.type.$cstNode;
  if (!prop || !cst || !typeCst) return null;
  let flags = typeCst.end;
  const candidates = [
    GrammarUtils.findNodeForProperty(cst, "access"),
    GrammarUtils.findNodeForProperty(cst, "provenanced"),
    prop.sensitivity?.$cstNode,
  ];
  for (const n of candidates) if (n && n.end > flags) flags = n.end;
  const afterDefault = prop.default?.$cstNode?.end ?? flags;
  const messageCst = GrammarUtils.findNodeForProperty(cst, "message");
  const afterCheck = messageCst?.end ?? prop.check?.$cstNode?.end ?? afterDefault;
  return { prop, cst, flags, afterDefault, afterCheck };
}

/** Extend a removal start over the one preceding space/tab run — but never over
 *  a line's indentation, so a clause written on its own line keeps it. */
function eatLeadingSpace(source: string, offset: number): number {
  let start = offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  return start > 0 && source[start - 1] === "\n" ? offset : start;
}

/** Normalise a caller's clause text: trimmed, or null when it means "remove".
 *  A multi-line value is rejected outright — these splices promise to stay on
 *  the property's own line. */
function clauseText(raw: string | null | undefined): string | null | undefined {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === "") return null;
  return /[\r\n]/.test(text) ? undefined : text;
}

export function setFieldDefault(
  source: string,
  kind: NodeKind,
  owner: string,
  index: number,
  exprText: string | null,
): string | null {
  const spans = propSpans(locate(source, kind, owner), index);
  const text = clauseText(exprText);
  if (!spans || text === undefined) return null;
  const existing = spans.prop.default?.$cstNode;
  const eq = existing ? GrammarUtils.findNodeForKeyword(spans.cst, "=") : undefined;
  if (existing && eq) {
    if (text === null) {
      return ifParses(
        applyEdits(source, [
          { offset: eatLeadingSpace(source, eq.offset), end: existing.end, newText: "" },
        ]),
      );
    }
    return ifParses(
      applyEdits(source, [{ offset: eq.offset, end: existing.end, newText: `= ${text}` }]),
    );
  }
  if (text === null) return source;
  return ifParses(
    applyEdits(source, [{ offset: spans.flags, end: spans.flags, newText: ` = ${text}` }]),
  );
}

export function setFieldCheck(
  source: string,
  kind: NodeKind,
  owner: string,
  index: number,
  exprText: string | null,
  /** `undefined` keeps the existing message; `null` / `""` removes it. */
  message?: string | null,
): string | null {
  const spans = propSpans(locate(source, kind, owner), index);
  const text = clauseText(exprText);
  if (!spans || text === undefined) return null;
  const keep = message === undefined ? (spans.prop.message ?? null) : message;
  const msg = clauseText(keep);
  if (msg === undefined) return null;
  const existing = spans.prop.check?.$cstNode;
  const checkKw = existing ? GrammarUtils.findNodeForKeyword(spans.cst, "check") : undefined;
  // `msg` re-quotes through JSON.stringify — the STRING terminal hands back the
  // value with its delimiters already stripped.
  const clause = text === null ? "" : `check ${text}${msg === null ? "" : ` message ${JSON.stringify(msg)}`}`;
  if (existing && checkKw) {
    const offset = clause === "" ? eatLeadingSpace(source, checkKw.offset) : checkKw.offset;
    return ifParses(
      applyEdits(source, [{ offset, end: spans.afterCheck, newText: clause }]),
    );
  }
  if (clause === "") return source;
  return ifParses(
    applyEdits(source, [
      { offset: spans.afterDefault, end: spans.afterDefault, newText: ` ${clause}` },
    ]),
  );
}

export function setFieldMask(
  source: string,
  kind: NodeKind,
  owner: string,
  index: number,
  exprText: string | null,
): string | null {
  const spans = propSpans(locate(source, kind, owner), index);
  const text = clauseText(exprText);
  if (!spans || text === undefined) return null;
  const existing = spans.prop.maskUnless?.$cstNode;
  const maskKw = existing ? GrammarUtils.findNodeForKeyword(spans.cst, "mask") : undefined;
  if (existing && maskKw) {
    if (text === null) {
      return ifParses(
        applyEdits(source, [
          { offset: eatLeadingSpace(source, maskKw.offset), end: existing.end, newText: "" },
        ]),
      );
    }
    return ifParses(
      applyEdits(source, [{ offset: maskKw.offset, end: existing.end, newText: `mask unless ${text}` }]),
    );
  }
  if (text === null) return source;
  return ifParses(
    applyEdits(source, [
      { offset: spans.afterCheck, end: spans.afterCheck, newText: ` mask unless ${text}` },
    ]),
  );
}

export function setFieldAccess(
  source: string,
  kind: NodeKind,
  owner: string,
  index: number,
  /** One of the five keywords, or `null` for the keyword-less `editable` default. */
  access: FieldAccess | null,
): string | null {
  if (access !== null && !FIELD_ACCESS.includes(access)) return null;
  const spans = propSpans(locate(source, kind, owner), index);
  if (!spans) return null;
  const existing = GrammarUtils.findNodeForProperty(spans.cst, "access");
  if (existing) {
    if (access === null) {
      return ifParses(
        applyEdits(source, [
          { offset: eatLeadingSpace(source, existing.offset), end: existing.end, newText: "" },
        ]),
      );
    }
    return ifParses(
      applyEdits(source, [{ offset: existing.offset, end: existing.end, newText: access }]),
    );
  }
  if (access === null) return source;
  return ifParses(
    applyEdits(source, [{ offset: spans.flags, end: spans.flags, newText: ` ${access}` }]),
  );
}

export function setFieldSensitivity(
  source: string,
  kind: NodeKind,
  owner: string,
  index: number,
  tags: string[] | null,
): string | null {
  const clean = (tags ?? []).map((t) => t.trim()).filter((t) => t !== "");
  // Tags are bare identifiers; a stray comma or space inside one would silently
  // re-split the clause on re-parse, so reject it here rather than write it.
  if (clean.some((t) => !IDENTIFIER.test(t))) return null;
  const spans = propSpans(locate(source, kind, owner), index);
  if (!spans) return null;
  const existing = spans.prop.sensitivity?.$cstNode;
  const clause = clean.length === 0 ? "" : `sensitive(${clean.join(", ")})`;
  if (existing) {
    const offset = clause === "" ? eatLeadingSpace(source, existing.offset) : existing.offset;
    return ifParses(applyEdits(source, [{ offset, end: existing.end, newText: clause }]));
  }
  if (clause === "") return source;
  return ifParses(
    applyEdits(source, [{ offset: spans.flags, end: spans.flags, newText: ` ${clause}` }]),
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
