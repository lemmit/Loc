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

import type { WithAccess } from "../../ir/enrich/wire-projection.js";
import { forCreateInput } from "../../ir/enrich/wire-projection.js";
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

/**
 * Fields the SERVER must seed with a plain literal default during domain
 * CONSTRUCTION (the public `create` factory), because they are outside the
 * create-input set (`forCreateInput` drops `token`/`managed`/`internal`) so no
 * client param carries them, yet their default is a client-evaluable constant
 * (`renderDefaultSeed` non-null — a literal or enum member) rather than a
 * server-stamp (`now()`/`currentUser.*`, applied by the audit/prepare path) or
 * a still-deferred sequence/lookup.
 *
 * The canonical case is the `versioned` capability's `version: int token = 1`
 * (RS-11): `token` drops it from the create body, so unless the factory seeds
 * the `= 1` default the field falls to the persistence-layer zero and the
 * created aggregate reads back at version 0.  node avoids this by stamping
 * `version = 1` in its versioned save; seeding here fixes the divergence on the
 * ORM backends (dotnet/java/python) persistence-agnostically — every create
 * path flows through the domain factory regardless of the persistence adapter.
 *
 * The predicate identifies the fields; each backend renders the VALUE with its
 * own domain-expression renderer (`renderCsExpr`/…), which handles a superset
 * of `renderDefaultSeed`'s subset, so a matched field always renders.
 */
export function constructionSeededDefaults<T extends WithAccess & FieldWithDefault>(
  fields: readonly T[],
): (T & { default: ExprIR })[] {
  const inputNames = new Set(forCreateInput(fields).map((f) => f.name));
  return fields.filter(
    (f): f is T & { default: ExprIR } =>
      !inputNames.has(f.name) && f.default !== undefined && renderDefaultSeed(f.default) !== null,
  );
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
