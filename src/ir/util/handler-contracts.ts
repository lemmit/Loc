// Shared helpers for the explicit application/transport layer
// (unfoldable-api-derivation.md, Layer 3-4) — the request-record param + the
// response-record return.  Consumed by EVERY backend's explicit-handler emitter
// so they interpret a scaffolded handler's signature identically.
//
// A scaffolded (or hand-written) `commandHandler`/`queryHandler` now takes a
// SINGLE `command`/`query` record param (`cmd: CreateOrderCommand`,
// `query: GetOrderQuery`) and — for a read over the aggregate — declares a
// `<Agg>Response` return.  Both ride as `entity`-marked `TypeIR`s whose name is
// a declared `PayloadIR` (payloads are entity-marked in lowering; see
// `memberOnPayload` in `lower-expr.ts`), so a backend must consult `ctx.payloads`
// to tell a request/response RECORD from a real aggregate.

import type { BoundedContextIR, PayloadIR, TypeIR } from "../types/loom-ir.js";

/** The `command`/`query` request-record a handler param binds to, or `undefined`
 *  when the param is a plain id / scalar / value-object (bound from the route
 *  path or as a scalar body field the old way).  A record param means the
 *  request body (command) / path+query-string (query) deserialises into this
 *  payload's already-emitted DTO, and the handler body reads `param.<field>`. */
export function requestRecordFor(type: TypeIR, ctx: BoundedContextIR): PayloadIR | undefined {
  if (type.kind !== "entity") return undefined;
  return ctx.payloads.find(
    (p) => p.name === type.name && (p.kind === "command" || p.kind === "query"),
  );
}

/** Normalise a handler's declared return type to the domain entity the handler
 *  body actually produces — so the INTERNAL handler signature (and the transport
 *  projection) type on the entity, not its wire contract.  Handles BOTH:
 *   - the declared type IS the entity (`Order` / `Order[]`) — hand-written form;
 *   - the declared type is the entity's `<X>Response` record (scaffolded reads)
 *     — mapped back to the entity `X` it projects, keeping array-ness.
 *  A scalar / id / non-entity / void return passes through unchanged, so a
 *  backend can feed the result to its existing type renderer + projection
 *  trigger with no other change. */
export function normalizeHandlerReturn(
  returnType: TypeIR | undefined,
  ctx: BoundedContextIR,
): TypeIR | undefined {
  if (!returnType) return returnType;
  const base = returnType.kind === "array" ? returnType.element : returnType;
  if (base.kind !== "entity") return returnType;
  const entity = entityForResponseName(base.name, ctx);
  if (!entity || entity === base.name) return returnType;
  const entityBase: TypeIR = { kind: "entity", name: entity };
  return returnType.kind === "array" ? { kind: "array", element: entityBase } : entityBase;
}

/** Map a `<X>Response` payload name back to the entity `X` (aggregate or
 *  containment part) it projects, or return the name unchanged when it already
 *  names an entity / isn't a response record. */
function entityForResponseName(name: string, ctx: BoundedContextIR): string | undefined {
  if (ctx.aggregates.some((a) => a.name === name)) return name;
  if (ctx.aggregates.some((a) => a.parts.some((p) => p.name === name))) return name;
  const isResponse = ctx.payloads.some((p) => p.kind === "response" && p.name === name);
  if (!isResponse) return name;
  const stripped = name.replace(/Response$/, "");
  if (ctx.aggregates.some((a) => a.name === stripped)) return stripped;
  if (ctx.aggregates.some((a) => a.parts.some((p) => p.name === stripped))) return stripped;
  return name;
}
