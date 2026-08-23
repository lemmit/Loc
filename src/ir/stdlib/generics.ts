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
 *   provenanced(T) → { value: T; lineage: json | null }
 *                 The `provenanced` field modifier's WIRE carrier (M-T6.12).
 *                 Synthesized by enrichment, never written in `.ddd`, and
 *                 rendered structurally rather than monomorphized — see the
 *                 entry's comment below.
 */

import { upperFirst } from "../../util/naming.js";
import { PROVENANCE_LINEAGE_FIELD, PROVENANCE_VALUE_FIELD } from "../../util/provenance-carrier.js";

export { PROVENANCE_LINEAGE_FIELD, PROVENANCE_VALUE_FIELD };

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
const jsonType: TypeIR = { kind: "primitive", name: "json" };

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
  // `Provenanced<T>` (M-T6.12) — the value + its lineage as ONE wire carrier.
  // Unlike its two siblings this ctor has no grammar arm: `total: int
  // provenanced` is a field MODIFIER, and the enrichment pass wraps the
  // property's wire type in this instance (`wireTypeForField`).  It is rendered
  // STRUCTURALLY (an inline `{ value, lineage }` object) by each wire consumer
  // off THIS field list, not monomorphized to a named DTO — so the shape has
  // exactly one definition and every backend/frontend agrees by construction.
  provenanced: {
    ctor: "provenanced",
    param: "T",
    fields: (arg) => [
      field("value", arg),
      // `json`, not a modelled record: `ProvLineage`'s interior is a runtime
      // audit blob (`{ snapshotId, target, inputs, computedValue }`) each
      // backend already emits its own typed class for.  Optional because a
      // field that has never been written carries no lineage yet.
      { name: PROVENANCE_LINEAGE_FIELD, type: jsonType, optional: true },
    ],
  },
};

/** If `t` is a `Provenanced<T>` carrier, return its carried type `arg`;
 *  otherwise null.  The single recogniser every wire consumer uses to decide
 *  "this field ships as `{ value, lineage }`, not as a bare `T`". */
export function provenancedCarrier(t: TypeIR): TypeIR | null {
  return t.kind === "genericInstance" && t.ctor === "provenanced" ? t.arg : null;
}

/** Look up a blessed shape by constructor name. */
export function genericShape(ctor: GenericCtorName): GenericShape {
  return GENERIC_SHAPES[ctor];
}

/** The field a `paged` envelope carries the ROWS in — the one member whose type
 *  depends on the carrier argument.  Everything else is page metadata. */
export const PAGED_ITEMS_MEMBER = "items";

/** The `paged` envelope's page-METADATA members — every field except the rows
 *  (`page`, `pageSize`, `total`, `totalPages`).  These are the members a page
 *  body reads off a paged `QueryView` binding (`rows.total`), and the ones a
 *  frontend has to resolve against the envelope rather than the row array.
 *
 *  Derived from `GENERIC_SHAPES.paged` rather than re-spelled, so widening the
 *  carrier reaches the frontends without a second edit.  The carrier argument
 *  is irrelevant here — only the field NAMES are read — so a `none` stands in. */
export const PAGED_META_MEMBERS: ReadonlySet<string> = new Set(
  GENERIC_SHAPES.paged
    .fields({ kind: "none" })
    .map((f) => f.name)
    .filter((n) => n !== PAGED_ITEMS_MEMBER),
);

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
    case "union":
      // Not a carrier (the carrier-bound check rejects a union arg); defensive
      // only — a union nested in a carrier arg (`T option paged`) still gets a
      // stable name.
      return `${arg.variants.map(genericArgName).join("Or")}Union`;
    case "none":
      return "None";
    case "action":
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

/** Declared UPPER bounds on the same two controls.  Without them the
 *  contract says `minimum: 1` and nothing else, so an in-contract
 *  `page × pageSize` overflows the SQL `OFFSET` (bigint) and the read 500s
 *  — a server error the caller reached by obeying the published schema
 *  (schemathesis F4, `docs/audits/schemathesis-findings-2026-08.md`).
 *
 *  The pair is chosen so the derived offset stays inside a 32-bit int on
 *  every backend that computes it in `int` arithmetic (.NET / Java):
 *  `(PAGED_MAX_PAGE - 1) * PAGED_MAX_PAGE_SIZE` ≈ 5·10⁸ < 2³¹. */
export const PAGED_MAX_PAGE = 1_000_000;
export const PAGED_MAX_PAGE_SIZE = 500;

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
