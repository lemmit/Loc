import { AstUtils, type AstNode } from "langium";
import type {
  Aggregate,
  EnumDecl,
  EventDecl,
  Model,
  Property,
  TypeRef,
  ValueObject,
} from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
// The playground re-exports the canonical primitive set the toolchain
// declares — keeps the field-builder's type picker in lockstep with
// the IR so a new primitive (e.g. `money` in #498) shows up here
// automatically.
import { PRIMITIVES, type PrimitiveName } from "../../../../src/ir/types/loom-ir.js";
import {
  mkIdType,
  mkNamedType,
  mkPrimitiveType,
  mkProperty,
  mkTypeRef,
} from "../../../../src/macros/api/index.js";
import { parseDdd } from "../parse";
import { spliceNode } from "../edit-engine";
import type { NodeKind } from "./model";

export { PRIMITIVES, type PrimitiveName };

// ---------------------------------------------------------------------------
// Inline field editing for the Model builder's Property-bearing constructs
// (aggregate / value object / event).  Each op re-parses the current source,
// finds the construct, mutates its property list in memory, reprints the whole
// construct with the structural printer, and splices it over the construct's
// CST range — the same parse → mutate → reprint → splice path add/delete/rename
// use.  TypeRef/Property literals are hand-built (no linking / `$container`
// needed): the printer reads only `$type` / `name` / `target.$refText` /
// `array` / `optional`.
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

function buildProperty(name: string, spec: TypeSpec): Property {
  return mkProperty({
    $type: "Property",
    name,
    type: buildTypeRef(spec),
    provenanced: false,
  });
}

// --- read helpers (for the inspector UI) -----------------------------------

export function listFields(node: AstNode): FieldInfo[] {
  return propertyList(node).list.map((p) => {
    const base = baseSpecOf(p.type);
    return { name: p.name, base, baseLabel: baseLabel(base), array: p.type.array, optional: p.type.optional };
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

// --- mutating ops (parse → mutate → reprint → splice) ----------------------

function commit(source: string, kind: NodeKind, name: string, mutate: (node: AstNode) => boolean): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  const node = findConstruct(fresh.ast, kind, name);
  if (!node) return null;
  if (!mutate(node)) return null;
  return spliceNode(source, node, printStructural(node));
}

export function addField(
  source: string,
  kind: NodeKind,
  name: string,
  fieldName: string,
  type: TypeSpec,
): string | null {
  return commit(source, kind, name, (node) => {
    propertyList(node).container.push(buildProperty(fieldName, type));
    return true;
  });
}

export function deleteField(source: string, kind: NodeKind, name: string, index: number): string | null {
  return commit(source, kind, name, (node) => {
    const { list, container } = propertyList(node);
    const target = list[index];
    if (!target) return false;
    const at = container.indexOf(target);
    if (at < 0) return false;
    container.splice(at, 1);
    return true;
  });
}

export function retypeField(
  source: string,
  kind: NodeKind,
  name: string,
  index: number,
  type: TypeSpec,
): string | null {
  return commit(source, kind, name, (node) => {
    const target = propertyList(node).list[index];
    if (!target) return false;
    target.type = buildTypeRef(type);
    return true;
  });
}

/** A field name not already used by the construct's fields. */
export function freshFieldName(node: AstNode): string {
  const taken = new Set(propertyList(node).list.map((p) => p.name));
  for (let i = 1; ; i++) {
    const candidate = `field${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
