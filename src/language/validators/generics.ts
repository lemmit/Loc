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
//
// A second rule pins *position*: a generic carrier is a transport shape, so it
// may only appear as a repository find's return type or as a payload field —
// never as a stored property, parameter, or signature elsewhere.  This keeps
// `genericInstance` out of the storage-side emitters entirely.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Model, TypeRef } from "../generated/ast.js";
import {
  isCapability,
  isFindDecl,
  isPayloadDecl,
  isProperty,
  isQueryHandler,
  isSelfType,
  isSlotType,
  isTypeRef,
} from "../generated/ast.js";

/** `Self id` (the anchored capability type, typed-capabilities.md) is only
 *  meaningful inside a `capability` body, where it resolves to the implementing
 *  aggregate's own type at splice time.  Anywhere else there is no implementor
 *  to resolve it to, so it is an error — the author should name a concrete
 *  `<Aggregate> id`. */
export function checkSelfType(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isSelfType(node)) continue;
    if (!AstUtils.getContainerOfType(node, isCapability)) {
      accept(
        "error",
        "`Self id` is only valid inside a `capability` body (it resolves to the " +
          "implementing aggregate's type). Use a concrete `<Aggregate> id` here.",
        { node, code: "loom.self-outside-capability" },
      );
    }
  }
}

export function checkGenericCarriers(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isTypeRef(node)) {
      checkTypeRefCarrier(node, accept);
      checkTypeRefPosition(node, accept);
    }
  }
}

/** A generic carrier is a transport shape, not a stored value — it may only
 *  appear as a repository find's return type or as a field of a payload
 *  (payload-transport-layer.md, P3b).  Anywhere else (a stored aggregate /
 *  value-object property, a parameter, a derived/state field, a function
 *  signature) is rejected, which also keeps the storage-side emitters
 *  (migrations, schema columns, wire-spec) free of `genericInstance`. */
function checkTypeRefPosition(t: TypeRef, accept: ValidationAcceptor): void {
  if (t.ctors.length === 0) return;
  const container = t.$container;
  // A find's return type: the TypeRef sits directly on the FindDecl (its
  // params are wrapped in `Parameter` nodes, so they don't match here).
  if (isFindDecl(container)) return;
  // A queryHandler's return type: the TypeRef sits directly on the QueryHandler
  // (`queryHandler X(...): <T> paged`).  A paged read exposed through the
  // application layer is the durable read-path vehicle (read-path-architecture.md,
  // "The ergonomic default") — the criterion runs through the read-only port and
  // the handler returns the `Paged<T>` envelope, so `paged`/`envelope` are legal
  // here exactly as on a find return.  Params are wrapped in `Parameter` nodes,
  // so a param carrier still doesn't match.
  if (isQueryHandler(container)) return;
  // A payload field: a `Property` whose owner is a `PayloadDecl`.
  if (isProperty(container) && isPayloadDecl(container.$container)) return;
  accept(
    "error",
    `A generic carrier ('${t.ctors.join(" ")}') is a transport shape — it may only appear as a ` +
      `repository find return type or a payload field, not in this position.`,
    { node: t, property: "ctors", code: "loom.generic-position" },
  );
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
