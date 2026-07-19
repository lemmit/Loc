// Server-sourced form-default classifier — the sibling of `default-seed.ts`.
//
// A `field: T = <expr>` default that the CLIENT can't evaluate
// (`renderDefaultSeed` returns `null`) splits two ways:
//   * SERVER-sourced — an ambient value the server already evaluates for
//     stamps (`now()`, `currentUser.*`): the create form fetches it from a
//     `GET /<plural>/prepare` endpoint and overlays it on the type-zero seed.
//   * still-deferred — a sequence or cross-aggregate lookup: no server
//     evaluation yet, so it keeps falling back to the type-zero seed.
//
// This module owns the ONE predicate that decides which fields the prepare
// endpoint emits AND which the form fetches — deriving both from the same
// function guarantees the emitted keys and the consumed keys can never drift
// (the analogue of `insertStampEntries` for audit stamps).  It is pure and
// target-neutral: the Hono route emitter and the frontend api-module both
// import it.

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { renderDefaultSeed } from "./default-seed.js";

/** A field/param carrying a lowered default expression. */
export interface FieldWithDefault {
  name: string;
  default?: ExprIR;
}

/** Whether the server can evaluate this default at prepare time — the ambient
 *  values the audit-stamp machinery already renders: `now()` and any
 *  `currentUser.*` claim.  Sequences and cross-aggregate `find`s are NOT yet
 *  server-sourced (a later slice); they return false and stay type-zero. */
function serverEvaluable(e: ExprIR): boolean {
  if (e.kind === "literal" && e.lit === "now") return true;
  return exprUsesCurrentUser(e);
}

/**
 * Whether a default expression is SERVER-sourced: outside the client-evaluable
 * subset (`renderDefaultSeed` returns `null`) AND something the server can
 * evaluate ambiently (`now()` / `currentUser.*`).  This is the exact boundary
 * the `default-seed.ts` header calls "a server prepare endpoint".
 */
export function isServerSourcedDefault(e: ExprIR): boolean {
  return renderDefaultSeed(e) === null && serverEvaluable(e);
}

/** The fields whose default is server-sourced — the keys the prepare endpoint
 *  emits and the form fetches.  Empty ⇒ no endpoint / no fetch (pure fallback). */
export function serverSourcedDefaultFields<T extends FieldWithDefault>(
  fields: readonly T[],
): (T & { default: ExprIR })[] {
  return fields.filter(
    (f): f is T & { default: ExprIR } =>
      f.default !== undefined && isServerSourcedDefault(f.default),
  );
}
