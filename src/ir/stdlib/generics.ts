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

import { upperFirst } from "../../util/naming.js";
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

/** PascalCase base name for a carrier argument — the stem of a monomorphized
 *  payload name.  v1 carriers are always a primitive / id / enum / value
 *  object / entity (the carrier-bound check rejects slot + nesting), so the
 *  default branch is defensive only. */
function genericArgName(arg: TypeIR): string {
  switch (arg.kind) {
    case "primitive":
      return upperFirst(arg.name);
    case "id":
      return `${upperFirst(arg.targetName)}Id`;
    case "enum":
    case "valueobject":
    case "entity":
      return arg.name;
    case "array":
      return `${genericArgName(arg.element)}List`;
    case "optional":
      return genericArgName(arg.inner);
    case "genericInstance":
      return genericInstanceName(arg.ctor, arg.arg);
    case "slot":
      return "Slot";
  }
}

/** Deterministic name of the concrete payload a `genericInstance` monomorphizes
 *  to: `<ArgName><Ctor>` — `string paged` → `StringPaged`, `Customer id paged`
 *  → `CustomerIdPaged`, `OrderPlaced envelope` → `OrderPlacedEnvelope`.  The
 *  single source of truth shared by enrichment (which synthesizes the payload
 *  under this name) and every backend (which maps a `genericInstance` reference
 *  to it). */
export function genericInstanceName(ctor: GenericCtorName, arg: TypeIR): string {
  return `${genericArgName(arg)}${upperFirst(ctor)}`;
}

/** Default 1-based page index and page size auto-applied to a `paged` find
 *  when the caller supplies no `page` / `pageSize` query parameter
 *  (payload-transport-layer.md, P3b). */
export const PAGED_DEFAULT_PAGE = 1;
export const PAGED_DEFAULT_PAGE_SIZE = 20;

/** If `t` is a top-level `paged(arg)` instantiation, return its carrier `arg`
 *  and the monomorphized payload `name`; otherwise null.  Used by every
 *  backend's find emitter to recognise a paginated return and wire the
 *  page/pageSize input + limit/offset/count query against the named DTO. */
export function pagedReturn(t: TypeIR): { arg: TypeIR; name: string } | null {
  if (t.kind === "genericInstance" && t.ctor === "paged") {
    return { arg: t.arg, name: genericInstanceName("paged", t.arg) };
  }
  return null;
}

/** Visit every `genericInstance` reachable from a type, descending array /
 *  optional / nested-instance wrappers.  Shared by the enrichment collector
 *  and any other phase that needs to find instantiations inside a type. */
export function forEachGenericInstance(
  type: TypeIR,
  visit: (inst: { ctor: GenericCtorName; arg: TypeIR }) => void,
): void {
  switch (type.kind) {
    case "genericInstance":
      // Visit the outer instance, then descend into its argument so a nested
      // instance (forward-compatible; v1 rejects it at validate) is still seen.
      visit({ ctor: type.ctor, arg: type.arg });
      forEachGenericInstance(type.arg, visit);
      return;
    case "array":
      forEachGenericInstance(type.element, visit);
      return;
    case "optional":
      forEachGenericInstance(type.inner, visit);
      return;
    default:
      return;
  }
}
