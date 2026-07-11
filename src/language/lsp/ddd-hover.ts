import type { AstNode, MaybePromise } from "langium";
import { AstNodeHoverProvider } from "langium/lsp";
import {
  type Aggregate,
  type Containment,
  type DerivedProp,
  type EntityPart,
  type EnumDecl,
  type EnumValue,
  type EventDecl,
  type FindDecl,
  type FunctionDecl,
  type Invariant,
  isAggregate,
  isContainment,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isEnumValue,
  isEventDecl,
  isExpression,
  isFindDecl,
  isFunctionDecl,
  isIdRef,
  isInvariant,
  isOperation,
  isParameter,
  isProperty,
  isRepository,
  isValueObject,
  type Operation,
  type Parameter,
  type Property,
  type Repository,
  type ValueObject,
} from "../generated/ast.js";
import {
  envForNode,
  iterateEntityMembers,
  resolveTypeRef,
  typeOf,
  typeToString,
} from "../type-system.js";

// ---------------------------------------------------------------------------
// DddHoverProvider — language-server hover content for `.ddd` files.
//
// Dispatches on the AST node under the cursor (or the cross-reference
// target, since `AstNodeHoverProvider` resolves refs for us) and emits
// a Markdown bubble.  Two flavours of content:
//
//   - Declarations (Aggregate, Property, EntityPart, …): a one-line
//     summary built from the node's shape.  No expression evaluation.
//
//   - Expression nodes (any subtype of `Expression`): the inferred
//     type rendered via `typeToString`, sourced from `typeOf` with an
//     `Env` built by `envForNode`.
//
// The Markdown is fenced in a `ddd` code block so VS Code applies our
// TextMate grammar to the hover bubble.
// ---------------------------------------------------------------------------

export class DddHoverProvider extends AstNodeHoverProvider {
  protected getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
    return this.contentFor(node);
  }

  private contentFor(node: AstNode): string | undefined {
    if (isAggregate(node)) return renderAggregate(node);
    if (isEntityPart(node)) return renderEntityPart(node);
    if (isValueObject(node)) return renderValueObject(node);
    if (isEnumDecl(node)) return renderEnum(node);
    if (isEnumValue(node)) return renderEnumValue(node);
    if (isEventDecl(node)) return renderEvent(node);
    if (isProperty(node)) return renderProperty(node);
    if (isContainment(node)) return renderContainment(node);
    if (isDerivedProp(node)) return renderDerived(node);
    if (isParameter(node)) return renderParameter(node);
    if (isFunctionDecl(node)) return renderFunction(node);
    if (isOperation(node)) return renderOperation(node);
    if (isRepository(node)) return renderRepository(node);
    if (isFindDecl(node)) return renderFind(node);
    if (isInvariant(node)) return renderInvariant(node);
    // Expressions cover every literal / ref / member-access / call /
    // operator node — type them via typeOf + envForNode.
    if (isExpression(node) || isIdRef(node)) {
      const env = envForNode(node);
      const t = typeOf(node, env);
      return code(typeToString(t));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-node renderers.  Each returns a fenced `ddd` code block as the
// summary line (so VS Code highlights it), optionally followed by a
// Markdown body line with member counts.
// ---------------------------------------------------------------------------

function renderAggregate(a: Aggregate): string {
  const counts = memberCounts(a);
  return `${code(`aggregate ${a.name}`)}\n\n${counts}`;
}

function renderEntityPart(p: EntityPart): string {
  const root = p.$container.name;
  const counts = memberCounts(p);
  return `${code(`entity ${p.name} in ${root}`)}\n\n${counts}`;
}

function renderValueObject(v: ValueObject): string {
  const counts = memberCounts(v);
  return `${code(`valueobject ${v.name}`)}\n\n${counts}`;
}

function renderEnum(e: EnumDecl): string {
  const values = e.values.map((v: EnumValue) => v.name).join(", ");
  return `${code(`enum ${e.name}`)}\n\nvalues: ${values}`;
}

function renderEnumValue(v: EnumValue): string {
  return code(`${v.$container.name}.${v.name}`);
}

function renderEvent(e: EventDecl): string {
  const fields = e.fields.map(propertySig).join(", ");
  return code(`event ${e.name} { ${fields} }`);
}

function renderProperty(p: Property): string {
  return code(propertySig(p));
}

function renderContainment(c: Containment): string {
  const partName = refName(c.partType);
  const suffix = c.collection ? "[]" : "";
  return code(`contains ${c.name}: ${partName}${suffix}`);
}

function renderDerived(d: DerivedProp): string {
  return code(`derived ${d.name}: ${typeToString(resolveTypeRef(d.type))}`);
}

function renderParameter(p: Parameter): string {
  return code(propertySig(p));
}

function renderFunction(fn: FunctionDecl): string {
  const params = fn.params.map(propertySig).join(", ");
  const ret = typeToString(resolveTypeRef(fn.returnType));
  return code(`function ${fn.name}(${params}): ${ret}`);
}

function renderOperation(op: Operation): string {
  const visibility = op.private ? "private " : "";
  const params = op.params.map(propertySig).join(", ");
  return code(`${visibility}operation ${op.name}(${params})`);
}

function renderRepository(r: Repository): string {
  return code(`repository ${r.name} for ${refName(r.aggregate)}`);
}

function renderFind(f: FindDecl): string {
  const params = f.params.map(propertySig).join(", ");
  const ret = typeToString(resolveTypeRef(f.returnType));
  return code(`find ${f.name}(${params}): ${ret}`);
}

function renderInvariant(_i: Invariant): string {
  return code("invariant");
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Render a cross-reference target name for a hover summary, surfacing
 *  resolution failures explicitly instead of a silent `?`:
 *   - resolved          → the target's name
 *   - typed but dangling → `«unresolved: <text>»` (keeps what the user wrote)
 *   - absent            → `«unresolved»`
 *  So hovering a `contains x: Missing[]` / `repository R for Missing` reads as
 *  a failure rather than looking like a valid reference. */
function refName(ref: { ref?: { name: string }; $refText?: string } | undefined): string {
  if (ref?.ref) return ref.ref.name;
  if (ref?.$refText) return `«unresolved: ${ref.$refText}»`;
  return "«unresolved»";
}

function propertySig(p: { name: string; type: import("../generated/ast.js").TypeRef }): string {
  return `${p.name}: ${typeToString(resolveTypeRef(p.type))}`;
}

function memberCounts(target: Aggregate | EntityPart | ValueObject): string {
  const members = iterateEntityMembers(target);
  const buckets = { property: 0, containment: 0, derived: 0, function: 0, operation: 0 };
  for (const m of members) buckets[m.kind]++;
  const parts: string[] = [];
  if (buckets.property)
    parts.push(`${buckets.property} propert${buckets.property === 1 ? "y" : "ies"}`);
  if (buckets.containment)
    parts.push(`${buckets.containment} contain${buckets.containment === 1 ? "ment" : "ments"}`);
  if (buckets.derived) parts.push(`${buckets.derived} derived`);
  if (buckets.function)
    parts.push(`${buckets.function} function${buckets.function === 1 ? "" : "s"}`);
  if (buckets.operation)
    parts.push(`${buckets.operation} operation${buckets.operation === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "_(empty)_";
}

function code(s: string): string {
  return "```ddd\n" + s + "\n```";
}
