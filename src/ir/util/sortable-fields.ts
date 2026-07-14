// Server-side sort whitelist (M-T2.6 / M-T1.1 slice 9).
//
// A paged list endpoint accepts `?sort=<field>&dir=asc|desc` and applies a
// server-side ORDER BY.  The `<field>` must be validated against a fixed
// whitelist — an unrestricted column name is an injection / invalid-column
// risk, and only scalar root columns can be ordered by anyway.  The whitelist
// is derived from the aggregate's `wireShape`: the `id` token plus every
// scalar `property` field (primitive- or enum-typed — those map to a single
// root-table column).  Containments, derived fields, and value-object /
// entity-typed properties are excluded (not single orderable columns).
//
// Shared across every backend's route/repo emitter and the frontend hook so the
// accepted sort keys agree end-to-end.

import type { AggregateIR } from "../types/loom-ir.js";

/** The ordered list of field names a paged list may be sorted by — `id` first,
 *  then declared scalar properties in wire order.  Always non-empty (`id` is
 *  always present).  Reads the enriched `wireShape` (present at every call site
 *  — the emitters run post-enrichment); guards `undefined` so a base-typed
 *  `AggregateIR` param still compiles. */
export function sortableFields(agg: AggregateIR): string[] {
  const out: string[] = [];
  for (const f of agg.wireShape ?? []) {
    if (f.source !== "id" && f.source !== "property") continue;
    if (f.type.kind === "primitive" || f.type.kind === "enum") out.push(f.name);
  }
  // `id` is always sortable and the stable default; guarantee it leads even if a
  // future wireShape reorders.
  if (!out.includes("id")) out.unshift("id");
  return out;
}
