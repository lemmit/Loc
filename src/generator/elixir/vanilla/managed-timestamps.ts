// ---------------------------------------------------------------------------
// Which `createdAt`/`updatedAt` fields are SERVER-MANAGED on a vanilla aggregate.
//
// The vanilla backend historically treated any field NAMED `createdAt` /
// `updatedAt` as an audit-managed timestamp — excluded from the changeset cast
// and lifecycle-stamped (`stamp onCreate { createdAt := now() }` / `with audit`).
// That name-based assumption is wrong for a PLAIN declared field: a `Project`
// with `createdAt: datetime` (no `stamp`, no `audit`) is a normal client-supplied
// column, exactly as every other backend casts it.  Excluding it from the cast
// while the migration still emits it `NOT NULL` left `created_at` unpopulated →
// `23502 not_null_violation` on insert.
//
// A `createdAt`/`updatedAt` field is server-managed iff it is an actual STAMP
// TARGET (assigned in the aggregate's `contextStamps`) or `access: "managed"`.
// A plain declared field is neither, and is cast + validated like any column.
// ---------------------------------------------------------------------------
import type { AggregateIR, FieldIR } from "../../../ir/types/loom-ir.js";

const TIMESTAMP_NAMES = ["createdAt", "updatedAt"] as const;

/** The `createdAt`/`updatedAt` field names on `agg` that are server-managed
 *  (stamp target or `access: "managed"`) and so must stay OUT of the changeset
 *  cast — the lifecycle stamp owns their value.  A plain declared timestamp
 *  field is absent from this set and is cast like a normal column. */
export function managedTimestampNames(agg: AggregateIR): Set<string> {
  const stampTargets = new Set(
    (agg.contextStamps ?? []).flatMap((s) => s.assignments.map((a) => a.field)),
  );
  const managedAccess = new Set(
    (agg.fields as FieldIR[]).filter((f) => f.access === "managed").map((f) => f.name),
  );
  const out = new Set<string>();
  for (const name of TIMESTAMP_NAMES) {
    const declared = (agg.fields as FieldIR[]).some((f) => f.name === name);
    if (declared && (stampTargets.has(name) || managedAccess.has(name))) out.add(name);
  }
  return out;
}
