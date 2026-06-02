/**
 * Stdlib generic-carrier registry (payload-transport-layer.md, P3).
 *
 * The single source of truth for the blessed closed set of carrier-bounded
 * generic payloads (`paged`, `envelope`).  Each entry maps a constructor name
 * to a `fields(arg)` builder that produces the concrete `FieldIR[]` of the
 * instantiated shape — `arg` is the carrier type argument substituted into the
 * template.
 *
 * Pure and dependency-free: consumed by the carrier-bound validator and the
 * P3a not-implemented gate today, and by P3b monomorphization (which turns
 * each distinct `genericInstance` into a synthesized `PayloadIR` named after
 * the ctor × arg) tomorrow.  Keeping the shape here — rather than inline in a
 * backend emitter — is what guarantees every backend renders the identical
 * wire shape.
 *
 * Wire shapes (pinned with the user — see the P3 plan, G3/G6):
 *   paged(T)    → { items: T[]; page: int; pageSize: int; total: int; totalPages: int }
 *                 1-based `page`; `totalPages` kept so clients don't recompute;
 *                 `hasNext`/`hasPrev` omitted (trivially derivable).
 *   envelope(T) → { id: string; ts: datetime; body: T }
 */

import type { FieldIR, GenericCtorName, TypeIR } from "../types/loom-ir.js";

/** A blessed generic-carrier shape: its single type-parameter name (for docs
 *  and diagnostics) and a builder that yields the instantiated fields. */
export interface GenericShape {
  /** Constructor keyword, matching the `GenericCtor` grammar rule. */
  ctor: GenericCtorName;
  /** Display name of the single type parameter (documentation / diagnostics). */
  param: string;
  /** The instantiated record fields, with `arg` substituted for the parameter. */
  fields(arg: TypeIR): FieldIR[];
}

const intType: TypeIR = { kind: "primitive", name: "int" };
const stringType: TypeIR = { kind: "primitive", name: "string" };
const datetimeType: TypeIR = { kind: "primitive", name: "datetime" };

function field(name: string, type: TypeIR): FieldIR {
  return { name, type, optional: false };
}

/** The blessed closed set of generic carriers (v1, A7a).  Keyed by ctor name;
 *  kept in lockstep with the `GenericCtor` grammar rule and the
 *  `GenericCtorName` IR union. */
export const GENERIC_SHAPES: Record<GenericCtorName, GenericShape> = {
  paged: {
    ctor: "paged",
    param: "T",
    fields: (arg) => [
      field("items", { kind: "array", element: arg }),
      field("page", intType),
      field("pageSize", intType),
      field("total", intType),
      field("totalPages", intType),
    ],
  },
  envelope: {
    ctor: "envelope",
    param: "P",
    fields: (arg) => [field("id", stringType), field("ts", datetimeType), field("body", arg)],
  },
};

/** All blessed constructor names — the closed set the grammar admits. */
export const GENERIC_CTOR_NAMES = Object.keys(GENERIC_SHAPES) as GenericCtorName[];

/** Look up a blessed shape by constructor name. */
export function genericShape(ctor: GenericCtorName): GenericShape {
  return GENERIC_SHAPES[ctor];
}
