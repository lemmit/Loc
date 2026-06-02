// Generic-carrier checks (payload-transport-layer.md, phase P3).
//
// Carrier-bound rule for ML-postfix generic instantiation (`customer paged`,
// `event envelope`).  The single type argument of a blessed generic carrier
// must itself be a *carrier* — a primitive, an `X id`, an enum, a value
// object, or an entity (aggregate / entity part, which project through their
// wire shape).  Two shapes are rejected:
//
//   * a `slot` argument — `slot` is a UI-only param marker, never a
//     boundary-crossing carrier; and
//   * a nested generic argument (`event envelope paged`) — v1 ships only
//     single-level instantiation (A7a); nested carriers arrive with P3b
//     monomorphization.
//
// The grammar (`base (ctors+=GenericCtor)*`) admits both forms so the surface
// and IR stay forward-compatible, and lowering folds them faithfully; this
// model-level check is what restricts v1 to the supported subset.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Model, TypeRef } from "../generated/ast.js";
import { isSlotType, isTypeRef } from "../generated/ast.js";

export function checkGenericCarriers(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isTypeRef(node)) checkTypeRefCarrier(node, accept);
  }
}

function checkTypeRefCarrier(t: TypeRef, accept: ValidationAcceptor): void {
  if (t.ctors.length === 0) return;

  // Nesting: with two or more postfix constructors, every constructor past
  // the innermost receives a generic-instance argument — not a carrier.
  // `event envelope paged` → `paged(envelope(event))`; `paged`'s argument is
  // `envelope(event)`.  Rejected in v1.
  if (t.ctors.length > 1) {
    accept(
      "error",
      `Nested generic carriers are not supported yet — '${t.ctors.join(" ")}' applies ` +
        `'${t.ctors[t.ctors.length - 1]}' to another generic instance. v1 allows a single ` +
        `carrier constructor (P3b adds nesting).`,
      { node: t, property: "ctors", code: "loom.generic-arg-not-carrier" },
    );
    return;
  }

  // Single constructor: its argument is the base type.  Only `slot` is a
  // non-carrier base — primitives, ids, enums, value objects and entities are
  // all valid carriers (unresolved named refs are reported elsewhere).
  if (isSlotType(t.base)) {
    accept(
      "error",
      `'${t.ctors[0]}' requires a carrier type argument; 'slot' is a UI-only marker, ` +
        `not a boundary-crossing carrier.`,
      { node: t, property: "base", code: "loom.generic-arg-not-carrier" },
    );
  }
}
