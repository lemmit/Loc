// Discriminated-union checks (payload-transport-layer.md, P4).
//
// Both union surfaces produce a variant list:
//   * anonymous `A or B or C` — a `TypeRef` head atom plus its `alternatives`;
//   * named `payload Foo = A | B | C` — a `PayloadDecl`'s `variants`.
//
// Two AST-level rules pin the variant set:
//   * `loom.union-duplicate-variant` — each variant must be a distinct type.
//     `string or string` / `payload F = A | A` is rejected so the wire
//     discriminator (the per-variant `type` tag) stays unambiguous.
//   * `loom.union-variant-not-carrier` — a `slot` variant is rejected: `slot`
//     is a UI-only param marker, never a boundary-crossing union variant.
//
// Match exhaustiveness over a union scrutinee is deferred to P4b — it needs the
// resolved scrutinee type that arrives with union narrowing + emission.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Model, TypeAtom, TypeRef } from "../generated/ast.js";
import { isFindDecl, isPayloadDecl, isProperty, isSlotType, isTypeRef } from "../generated/ast.js";

export function checkUnions(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isTypeRef(node) && node.alternatives.length > 0) {
      // The anonymous `or` form: head atom + each alternative.
      checkVariants([node, ...node.alternatives], accept);
      checkUnionPosition(node, accept);
    } else if (isPayloadDecl(node) && node.variants.length > 0) {
      checkVariants(node.variants, accept);
    }
  }
}

/** An inline `A or B` union is a transport shape (like a generic carrier) — it
 *  may only appear as a repository find's return type or a payload field, not
 *  as a stored property / parameter elsewhere.  This keeps the `union` TypeIR
 *  out of the storage-side emitters (drizzle columns, migrations) that don't
 *  render it.  A *named* union (`payload Foo = A | B`) is referenced by name
 *  (an `entity` marker) and so is unaffected. */
function checkUnionPosition(t: TypeRef, accept: ValidationAcceptor): void {
  const container = t.$container;
  if (isFindDecl(container)) return;
  if (isProperty(container) && isPayloadDecl(container.$container)) return;
  accept(
    "error",
    `An inline 'or' union is a transport shape — it may only appear as a repository find ` +
      `return type or a payload field, not in this position. Name it with 'payload X = A | B' ` +
      `to use it elsewhere.`,
    { node: t, code: "loom.union-position" },
  );
}

/** Stable structural key for a variant atom — base identity plus the postfix
 *  ctor list and the array / optional markers.  Two variants with the same key
 *  are the same type (`string` vs `string?` differ; `Customer id` collides
 *  with another `Customer id`). */
function atomKey(a: TypeRef | TypeAtom): string {
  const base = a.base;
  let b: string;
  switch (base.$type) {
    case "PrimitiveType":
      b = base.name;
      break;
    case "SlotType":
      b = "slot";
      break;
    case "IdType":
      b = `id:${base.target.$refText}`;
      break;
    case "NamedType":
      b = base.target.$refText;
      break;
    default:
      b = "?";
  }
  return `${b}|${a.ctors.join(",")}|${a.array ? "[]" : ""}|${a.optional ? "?" : ""}`;
}

function checkVariants(variants: (TypeRef | TypeAtom)[], accept: ValidationAcceptor): void {
  const seen = new Set<string>();
  for (const v of variants) {
    if (isSlotType(v.base)) {
      accept(
        "error",
        `'slot' is a UI-only marker, not a union variant — every variant must be a carrier type.`,
        { node: v, property: "base", code: "loom.union-variant-not-carrier" },
      );
      continue;
    }
    const key = atomKey(v);
    if (seen.has(key)) {
      accept(
        "error",
        `Duplicate union variant — each variant must be a distinct type so the wire ` +
          `discriminator stays unambiguous.`,
        { node: v, code: "loom.union-duplicate-variant" },
      );
      continue;
    }
    seen.add(key);
  }
}
