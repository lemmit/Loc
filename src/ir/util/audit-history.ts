// -------------------------------------------------------------------------
// Entity history — the READ side of the `audited` command trail (docs/audit.md).
//
// The write side stores, per successful public command, an append-only
// `audit_records` row carrying full `before`/`after` wire-DTO snapshots.  This
// module defines the one platform-neutral shape every backend serves that trail
// as, and the two derivations that make serving it SAFE:
//
//   1. `auditEntryWireShape()` / `auditFieldChangeWireShape()` — the canonical
//      ordered wire fields, in the same `WireField` vocabulary every DTO
//      emitter already consumes.  One definition, five backends, byte-identical
//      key sets by construction rather than by five people agreeing.
//
//   2. `historyDiffFields(agg)` — WHICH of the aggregate's wire fields the
//      per-entry diff is computed over.  Derived at read time from the two
//      snapshots and never stored (a stored diff is a cache with no
//      invalidation story), minus the stamp churn `forHistoryDiff` excludes.
//
//   3. `maskedHistoryFields(agg)` — the fields whose change entry must be
//      DROPPED for a caller who fails the field's `mask unless` predicate.
//
// (3) is the load-bearing one.  The snapshots are written server-side INSIDE
// the command's transaction, where there is no caller to mask against, so they
// hold RAW values for every field — including the ones `mask unless` redacts on
// every other read surface.  A history endpoint that skips the masking pass
// therefore republishes each masked field's entire change history through a
// route nobody thought of as a read surface.  Dropping rather than redacting is
// deliberate: a redacted-but-present entry still discloses THAT the field
// changed, when, and by whom — "the admin changed `salary` on the 3rd" is the
// leak, not just its value.
//
// Platform-neutral and browser-safe: pure structural reads off the resolved IR.
// -------------------------------------------------------------------------
import { AUDIT_HISTORY_FIND } from "../../util/audit-names.js";
import { forHistoryDiff, wireFieldsFor } from "../enrich/wire-projection.js";
import type { AggregateIR, FindIR, TypeIR, WireField } from "../types/loom-ir.js";
import { aggHasAuditedTarget } from "./audit-capability.js";

/** Name of the derived per-entity history read — re-exported from `util/` so
 *  the phase-② scaffold macro can name the same read without value-importing
 *  `ir/` (see `src/util/audit-names.ts`).  This module's surface is unchanged. */
export { AUDIT_HISTORY_FIND } from "../../util/audit-names.js";

/** Wire type name of one history entry — the DTO every backend emits. */
export const AUDIT_ENTRY_TYPE = "AuditEntry";

/** Wire type name of one field-level change inside an entry. */
export const AUDIT_FIELD_CHANGE_TYPE = "AuditFieldChange";

const prim = (name: "string" | "datetime" | "json"): TypeIR => ({ kind: "primitive", name });

/** Build a wire field in the canonical history vocabulary.  Everything here is
 *  server-derived and read-only, so the access role is `immutable` — never
 *  `managed`, which would make the entry's own fields self-excluding if this
 *  shape were ever fed back through `forHistoryDiff`. */
function wf(name: string, type: TypeIR, optional = false): WireField {
  return { name, type, optional, source: "property", access: "immutable" };
}

/** One field-level change derived from an entry's two snapshots.
 *
 *  `before` / `after` are `json` because the snapshot holds whatever the
 *  aggregate's wire DTO held for that key — a scalar, a value object, a
 *  containment array.  Typing them as the field's own type would need one
 *  `AuditFieldChange` per field per aggregate; a `json` leaf keeps the entry
 *  shape uniform, which is what lets a single `Timeline` primitive render the
 *  history of any audited aggregate.
 *
 *  Both sides are nullable and both are meaningful: a `create` has no `before`
 *  (every field reads null → value) and a `destroy` has no `after`. */
export function auditFieldChangeWireShape(): WireField[] {
  return [
    wf("field", prim("string")),
    wf("before", prim("json"), true),
    wf("after", prim("json"), true),
  ];
}

/** One entry in an entity's history — the canonical ordered wire shape.
 *
 *  Deliberately NOT carrying the raw `before` / `after` snapshots.  They are
 *  stored unmasked (see the module header), so publishing them whole would need
 *  a recursive redaction pass over arbitrary JSON with no schema to guarantee
 *  it reached every masked key.  The derived `changes` list is a typed,
 *  field-keyed projection where the masking rule is exact and checkable: drop
 *  the entry whose `field` is masked for this caller.  Point-in-time state
 *  reconstruction ("time travel") is a separate feature and would need its own
 *  authorization story. */
export function auditEntryWireShape(): WireField[] {
  return [
    wf("auditId", prim("string")),
    wf("at", prim("datetime")),
    wf("action", prim("string")),
    wf("operationId", prim("string")),
    // The principal, as recorded at command time.  A `json` blob rather than a
    // typed principal: the `user {}` block's claim set is per-system, and the
    // recorded actor is a historical snapshot that need not still match it.
    wf("actor", prim("json"), true),
    wf("correlationId", prim("string"), true),
    wf("changes", { kind: "array", element: prim("json") }),
  ];
}

/** The aggregate wire fields an entry's `changes` list may cover — the API-read
 *  set minus stamp churn (`forHistoryDiff`).  A backend derives the diff by
 *  comparing these keys across the two snapshots; a key absent here is never
 *  looked at, so a `secret` or `internal` field cannot reach the timeline even
 *  though the snapshot holds it. */
export function historyDiffFields(agg: AggregateIR): WireField[] {
  return forHistoryDiff(wireFieldsFor(agg));
}

/** The diff fields carrying a `mask unless` predicate — the ones whose change
 *  entry is DROPPED (not redacted) when the caller fails the predicate.  Same
 *  predicate the aggregate's own read surface applies, so history can never
 *  disclose a field the entity read would have hidden. */
export function maskedHistoryFields(agg: AggregateIR): WireField[] {
  return historyDiffFields(agg).filter((f) => f.maskUnless !== undefined);
}

/** The diff fields with no mask — always visible to any caller who cleared the
 *  read gate. */
export function unmaskedHistoryFields(agg: AggregateIR): WireField[] {
  return historyDiffFields(agg).filter((f) => f.maskUnless === undefined);
}

/** True when this aggregate serves a history read: it has at least one audited
 *  command (so rows exist) AND at least one diffable field (so an entry could
 *  say something).  The second half matters — an aggregate whose every field is
 *  `managed`/`secret` would serve a timeline of empty entries, which reads as
 *  authoritative while carrying no information. */
export function aggServesHistory(agg: AggregateIR): boolean {
  return aggHasAuditedTarget(agg) && historyDiffFields(agg).length > 0;
}

/** The compiler-synthesized `find history(id)` for an audited aggregate.
 *
 *  Injected in the same enrichment slot as the auto-`findAll` so it rides the
 *  existing find pipeline: `requires` carries the inherited read gate, and
 *  `bypassAll` / `bypassCaps` carry the aggregate read's `ignoring` stance, so
 *  every capability query-filter (`tenantOwned` included) scopes the history
 *  read exactly as it scopes the entity read.  `auditHistory` marks it for the
 *  emitters, which serve it from `audit_records` rather than the aggregate
 *  table — the generic find-route and repository builders skip it. */
export function buildHistoryFind(agg: AggregateIR, requires?: FindIR["requires"]): FindIR {
  return {
    name: AUDIT_HISTORY_FIND,
    params: [
      { name: "id", type: { kind: "id", targetName: agg.name, valueType: agg.idValueType } },
    ],
    returnType: { kind: "array", element: { kind: "primitive", name: "json" } },
    auditHistory: true,
    ...(requires ? { requires } : {}),
  };
}
