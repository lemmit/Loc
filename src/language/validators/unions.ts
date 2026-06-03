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
import { isPayloadDecl, isSlotType, isTypeRef } from "../generated/ast.js";

export function checkUnions(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isTypeRef(node) && node.alternatives.length > 0) {
      // The anonymous `or` form: head atom + each alternative.
      checkVariants([node, ...node.alternatives], accept);
    } else if (isPayloadDecl(node) && node.variants.length > 0) {
      checkVariants(node.variants, accept);
    }
  }
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
