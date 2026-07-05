// -------------------------------------------------------------------------
// Shared "does this aggregate carry the `versioned` capability?" predicate.
//
// An aggregate opts into optimistic concurrency by declaring the built-in
// `versioned` capability (`aggregate X with versioned`, prelude.ts).  That
// capability contributes a single synthetic `version: int token = 1` field.
// Backends and the migrations builder gate three things on this marker:
//
//   1. the `version INTEGER NOT NULL DEFAULT 1` state-table column
//      (`migrations-builder.ts` → sql-pg / Ecto),
//   2. the guarded write (`UPDATE ... WHERE id = $1 AND version = $2`,
//      `version = version + 1`) in each backend's repository save,
//   3. the 409-conflict arm when the guarded write affects zero rows.
//
// It lives at IR level (`ir/util/`) so the validator, the system migrations
// builder, and every backend import it DOWN the pipeline — never re-deriving
// the gate per-backend (the drift trap `aggHasAuditedTarget` was factored out
// to avoid).  Mirrors the `agg.capabilities?.includes("tenantOwned")` /
// `agg.uniqueKeys?.length` gating style used by the sibling capabilities.
//
// Platform-neutral and browser-safe — a pure structural read off the resolved
// IR, no Node-only APIs.
// -------------------------------------------------------------------------
import type { AggregateIR } from "../types/loom-ir.js";

/** True when the aggregate declares the built-in `versioned` capability
 *  (optimistic concurrency).  The `version` field, its `token` wire access,
 *  and the state-table `version` column all follow from this. */
export function aggregateIsVersioned(agg: AggregateIR): boolean {
  return agg.capabilities?.includes("versioned") ?? false;
}
