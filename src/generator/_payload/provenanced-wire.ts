// ---------------------------------------------------------------------------
// `Provenanced<T>` — the single source of truth for the value+lineage wire
// carrier's SHAPE, shared by every backend DTO emitter and every frontend
// api-type/decoder emitter (M-T6.12,
// `docs/old/proposals/provenanced-wire-pair.md`).
//
// A `provenanced` field (docs/provenance.md) records the lineage of every value
// it holds.  Until this module existed, the value and the lineage were two
// CO-LOCATED SIBLINGS on the wire — a plain `total` key plus a trailing
// `total_provenance` key that each of the five backends and each of the six
// frontends appended by hand, out of band from `wireShape`.  Eleven
// hand-written spellings of one convention: invisible to
// `.loom/wire-spec.json` (built purely from `wireShape`), untouched by
// `forApiRead`'s access filtering, and one forgotten `.filter(f =>
// f.provenanced)` away from a backend silently dropping the audit trail it
// promised.
//
// Now the lineage rides INSIDE the field's own wire entry:
//
//     "total": { "value": 120, "lineage": { …ProvLineage… } | null }
//
// The shape is declared once in `GENERIC_SHAPES.provenanced`
// (`src/ir/stdlib/generics.ts`) and stamped into `wireShape` once by
// `wireTypeForField` (`src/ir/enrich/wire-projection.ts`).  This module is the
// GENERATOR-side reader of that declaration: emitters take the member names and
// their order from here instead of re-spelling `"value"` / `"lineage"`, so the
// key set cannot drift between targets even though each target formats its own
// object syntax (TS object literal / C# record params / Elixir map / Python
// model / Dart class / F# record).
// ---------------------------------------------------------------------------

import { GENERIC_SHAPES } from "../../ir/stdlib/generics.js";
import type { TypeIR } from "../../ir/types/loom-ir.js";
import { PROVENANCE_LINEAGE_FIELD, PROVENANCE_VALUE_FIELD } from "../../util/provenance-carrier.js";

export { PROVENANCE_LINEAGE_FIELD, PROVENANCE_VALUE_FIELD };

/** The carrier's member names in wire order — read off the shape definition
 *  rather than re-spelled, so widening the carrier reaches every emitter. */
export const PROVENANCED_WIRE_MEMBERS: readonly string[] = GENERIC_SHAPES.provenanced
  .fields({ kind: "none" })
  .map((f) => f.name);

/** True iff the carrier's `lineage` member may be ABSENT from the body.  It
 *  may — a field that has never been written carries no lineage.  Derived, so
 *  the emitters and the contract artifact agree. */
export const PROVENANCED_LINEAGE_OPTIONAL: boolean =
  GENERIC_SHAPES.provenanced
    .fields({ kind: "none" })
    .find((f) => f.name === PROVENANCE_LINEAGE_FIELD)?.optional === true;

/** True iff the carrier's `lineage` member may be `null` WHEN PRESENT.
 *
 *  F2-XB-7 — OPTIONALITY AND NULLABILITY ARE DIFFERENT CLAIMS, and this carrier
 *  is where the toolchain conflated them.  `GENERIC_SHAPES.provenanced` declares
 *  the member `optional: true` and nothing more, so each consumer picked a half
 *  and they diverged four ways for ONE member:
 *
 *    .loom/wire-spec.json   `lineage: {"type":"object"}`, `required:["value"]`
 *                           → optional, NOT nullable
 *    elixir OpenApiSpex     `%Schema{type: :object}`      → optional, NOT nullable
 *    node zod               `ProvenanceLineage.nullable()` inside the object,
 *                           not `.optional()`             → required + nullable
 *    python / the frontends `dict | None = None` / `.nullish()`
 *                                                         → optional + nullable
 *
 *  What every backend actually PUTS ON THE WIRE is an explicit null — node
 *  `lineage: root.total_provenance ?? null`, python `… if … else None`, elixir a
 *  nullable jsonb column read straight out.  JSON Schema applies a member's
 *  subschema whenever the key is PRESENT, and `required` does not save it, so a
 *  row whose provenanced field has never been written ships a body that
 *  violates the app's own published contract.
 *
 *  `src/util/provenance-carrier.ts` centralised the member NAMES so they could
 *  not drift; this is the same job for the member's nullability — declared once,
 *  read by every consumer, rather than re-decided per emitter. */
export const PROVENANCED_LINEAGE_NULLABLE = true;

/** The message every surface throws when a `Provenanced<T>` carrier turns up on
 *  the REQUEST side.  It cannot: `wireTypeForField` stamps the carrier onto the
 *  read/response projection only, and a create/update input carries the bare
 *  value the caller supplies (a client never authors a lineage).  One spelling,
 *  so the invariant reads the same wherever it is asserted. */
export const PROVENANCED_REQUEST_ERROR =
  "Provenanced<T> is a response-side wire carrier; a request field carries the bare value type.";

/** The carrier's members paired with a caller-rendered expression for each, in
 *  wire order.  Every emitter that BUILDS a carrier walks this instead of
 *  hand-writing the two keys, so the order and the names are the shape's, not
 *  the emitter's.
 *
 *  ```ts
 *  // Hono `toWire`
 *  const body = provenancedEntries("o.total", "o.total_provenance ?? null")
 *    .map(([k, v]) => `${k}: ${v}`).join(", ");   // → "value: o.total, lineage: o.total_provenance ?? null"
 *  ```
 */
export function provenancedEntries(
  value: string,
  lineage: string,
): readonly (readonly [string, string])[] {
  return [
    [PROVENANCE_VALUE_FIELD, value],
    [PROVENANCE_LINEAGE_FIELD, lineage],
  ];
}

/** The carrier's members paired with the TYPE each carries: the wrapped `T`
 *  for `value`, and `undefined` for `lineage` (an opaque `ProvLineage` audit
 *  blob every target already emits its own class/schema for — it is `json` in
 *  the IR precisely because Loom does not model its interior).  Emitters that
 *  declare the carrier's TYPE walk this. */
export function provenancedTypeMembers(
  carried: TypeIR,
): readonly { name: string; type?: TypeIR; optional: boolean }[] {
  return [
    { name: PROVENANCE_VALUE_FIELD, type: carried, optional: false },
    { name: PROVENANCE_LINEAGE_FIELD, optional: PROVENANCED_LINEAGE_OPTIONAL },
  ];
}
