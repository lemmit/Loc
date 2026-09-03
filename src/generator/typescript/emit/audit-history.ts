// ---------------------------------------------------------------------------
// Entity history — the READ side of the `audited` command trail, node / Hono.
// (docs/audit.md; the shape + diff boundary live at IR level in
// `src/ir/util/audit-history.ts`, shared with the other four backends.)
//
// Two emitted pieces:
//
//   1. `audit/history.ts` — a per-project module with the `AuditEntry` /
//      `AuditFieldChange` wire types, their Zod response schemas, and the two
//      pure helpers the per-aggregate mappers call.  Shape-only: it carries no
//      aggregate knowledge, so one copy serves every audited aggregate.
//
//   2. A per-aggregate `<agg>AuditEntry(row, currentUser)` mapper, emitted into
//      the aggregate's route file (it needs the aggregate's field set and — the
//      point of the exercise — its `mask unless` predicates, which render
//      against the same `User` type the route file already imports).
//
// ── Why the mapper is per-aggregate and per-caller ─────────────────────────
// An audit row's `before`/`after` snapshots are written server-side INSIDE the
// command's transaction.  There is no caller there to mask against, so they
// hold RAW values for every field the wire DTO had — including every
// `mask unless` field.  The mapper is the only place a caller enters the
// picture, so it is where masking has to happen.
//
// A masked field's change entry is DROPPED, never emitted-and-redacted.  A
// redacted-but-present entry still discloses THAT the field changed, when, and
// by whom; "the admin changed `salary` on the 3rd" is the leak, not just the
// number.  Fail-closed on a null principal, exactly like `toWireMasked`.
// ---------------------------------------------------------------------------

import type { EnrichedAggregateIR } from "../../../ir/types/loom-ir.js";
import {
  historyDiffFields,
  maskedHistoryFields,
  unmaskedHistoryFields,
} from "../../../ir/util/audit-history.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsExpr } from "../render-expr.js";
import { canonicalIsoExpr } from "../repository-wire-builder.js";

/** Name of the per-aggregate row → wire-entry mapper emitted into the route
 *  file. */
export function historyMapperName(agg: EnrichedAggregateIR): string {
  return `${lowerFirst(agg.name)}AuditEntry`;
}

/** The per-project `audit/history.ts` module: wire types, Zod response schemas
 *  and the pure helpers.  Emitted once whenever the deployable serves any
 *  history read. */
export function renderAuditHistoryModule(): string {
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    "//",
    "// Entity history — the read side of the `audited` command trail.  One entry",
    "// per SUCCESSFUL command (a failed command's transaction rolls back, taking",
    '// its audit row with it), so this answers "what changed", not "who tried".',
    'import { z } from "@hono/zod-openapi";',
    "",
    "/** One field-level change, derived from an entry's two snapshots at READ",
    " *  time.  `before` and `after` are opaque JSON: whatever the aggregate's wire",
    " *  DTO held for that key.  Both sides are nullable and both are meaningful —",
    " *  a `create` has no `before`, a `destroy` has no `after`. */",
    "export interface AuditFieldChange {",
    "  field: string;",
    "  before: unknown;",
    "  after: unknown;",
    "}",
    "",
    "/** One entry in an entity's history. */",
    "export interface AuditEntry {",
    "  auditId: string;",
    "  at: string;",
    "  action: string;",
    "  operationId: string;",
    "  actor: unknown;",
    "  correlationId: string | null;",
    "  changes: AuditFieldChange[];",
    "}",
    "",
    "/** One stored `audit_records` row, as the history query hands it back. */",
    "export interface AuditHistoryRow {",
    "  auditId: string;",
    "  operationId: string;",
    "  action: string;",
    "  actor: unknown;",
    "  before: unknown;",
    "  after: unknown;",
    "  at: Date;",
    "  correlationId: string | null;",
    "}",
    "",
    "export const AuditFieldChangeResponse = z",
    "  .object({",
    "    field: z.string(),",
    "    before: z.unknown().nullable(),",
    "    after: z.unknown().nullable(),",
    "  })",
    '  .openapi("AuditFieldChange");',
    "",
    "export const AuditEntryResponse = z",
    "  .object({",
    "    auditId: z.string(),",
    "    at: z.string(),",
    "    action: z.string(),",
    "    operationId: z.string(),",
    "    actor: z.unknown().nullable(),",
    "    correlationId: z.string().nullable(),",
    "    changes: z.array(AuditFieldChangeResponse),",
    "  })",
    '  .openapi("AuditEntry");',
    "",
    "/** Read one key out of a snapshot.  A missing key and an explicit null are",
    " *  the same thing here — a `create` row has no `before` object at all, and",
    " *  its fields must read as null rather than crash. */",
    "export function auditSnapshotValue(snapshot: unknown, key: string): unknown {",
    '  if (snapshot === null || typeof snapshot !== "object") return null;',
    "  return (snapshot as Record<string, unknown>)[key] ?? null;",
    "}",
    "",
    "/** Did this key actually change between the two snapshots?",
    " *",
    " *  Structural comparison via JSON, which is key-order sensitive — safe here",
    " *  because both snapshots come from the SAME `toWire` projection, whose key",
    " *  order is fixed by the aggregate's wire shape.  Comparing serialized form",
    " *  also means a value object or containment array compares by content rather",
    ' *  than by reference, which is what a reader expects of "changed". */',
    "export function auditValueChanged(before: unknown, after: unknown): boolean {",
    "  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);",
    "}",
  );
}

/** The per-aggregate `row → AuditEntry` mapper, with the masking pass folded
 *  in.  Unmasked diff fields run through one loop; each masked field gets its
 *  own predicate-guarded block, so a caller who fails the predicate sees no
 *  entry for it at all. */
export function renderHistoryEntryMapper(agg: EnrichedAggregateIR): string {
  const unmasked = unmaskedHistoryFields(agg);
  const masked = maskedHistoryFields(agg);
  const body: string[] = [
    // The principal parameter exists only when there is a mask to apply.  A
    // mask-free aggregate takes none — which also keeps the mapper off
    // `auth/user-types`, a module that is emitted only under `auth: required`.
    // (A `mask unless` predicate reads `currentUser`, so a masked aggregate
    // always has auth and the module is always there.)  The type is referenced
    // inline rather than via a top-level import, matching how the mask-aware
    // response routes bind `__maskUser`.
    masked.length > 0
      ? `function ${historyMapperName(agg)}(row: AuditHistoryRow, currentUser: import("../auth/user-types").User | null): AuditEntry {`
      : `function ${historyMapperName(agg)}(row: AuditHistoryRow): AuditEntry {`,
    `  const changes: AuditFieldChange[] = [];`,
  ];
  if (unmasked.length > 0) {
    const keys = unmasked.map((f) => JSON.stringify(f.name)).join(", ");
    body.push(
      `  for (const key of [${keys}]) {`,
      `    const before = auditSnapshotValue(row.before, key);`,
      `    const after = auditSnapshotValue(row.after, key);`,
      `    if (auditValueChanged(before, after)) changes.push({ field: key, before, after });`,
      `  }`,
    );
  }
  for (const f of masked) {
    // `maskUnless` is a `currentUser`-only predicate — the SAME one
    // `toWireMasked` applies on the entity read, so history can never disclose
    // a field the entity read would have hidden.  Fail-closed on a null
    // principal; the whole block is skipped rather than the value nulled.
    const pred = renderTsExpr(f.maskUnless!, { thisName: "this", principalExpr: "currentUser" });
    body.push(
      `  // \`${f.name}\`: \`mask unless\` — the change entry is DROPPED, not redacted.`,
      `  // A redacted-but-present entry would still disclose that it changed, when,`,
      `  // and by whom, which is the disclosure the mask exists to prevent.`,
      `  if (currentUser !== null && (${pred})) {`,
      `    const before = auditSnapshotValue(row.before, ${JSON.stringify(f.name)});`,
      `    const after = auditSnapshotValue(row.after, ${JSON.stringify(f.name)});`,
      `    if (auditValueChanged(before, after))`,
      `      changes.push({ field: ${JSON.stringify(f.name)}, before, after });`,
      `  }`,
    );
  }
  body.push(
    `  return {`,
    `    auditId: row.auditId,`,
    // The audit trail's `at` is a `datetime` on the WIRE, so it takes the same
    // canonical RS-4 form every other wire datetime does — a bare
    // `toISOString()` always pads the fraction to `.000`, which put node alone
    // against the other four on this endpoint (.NET regex-trims, java's
    // `Instant.toString()` and python's `iso()` omit a zero fraction) long after
    // F2-W-05 was closed on the aggregate `toWire` path.
    `    at: ${canonicalIsoExpr("row.at")},`,
    `    action: row.action,`,
    `    operationId: row.operationId,`,
    `    actor: row.actor ?? null,`,
    `    correlationId: row.correlationId,`,
    `    changes,`,
    `  };`,
    `}`,
  );
  return lines(...body);
}

/** The history query, per persistence adapter.  Mirrors `historyInsertCall`'s
 *  drizzle/mikroorm split on the write side, so both adapters are covered in
 *  one place rather than one of them silently missing the read.
 *
 *  Ordered oldest-first: a timeline reads forwards, and `at` + the
 *  `(target_type, target_id)` index make it the natural scan order. */
export function historySelectStatement(agg: EnrichedAggregateIR, usingMikro: boolean): string[] {
  if (usingMikro) {
    return [
      `const __rows = await db.find(AuditRecordRow, { targetType: ${JSON.stringify(agg.name)}, targetId: id }, { orderBy: { at: "asc" } });`,
    ];
  }
  return [
    `const __rows = await db`,
    `  .select()`,
    `  .from(schema.auditRecords)`,
    `  .where(and(eq(schema.auditRecords.targetType, ${JSON.stringify(agg.name)}), eq(schema.auditRecords.targetId, id)))`,
    `  .orderBy(schema.auditRecords.at);`,
  ];
}

/** The mapper's call arguments at the route site — the principal only when the
 *  aggregate actually has a mask to apply. */
export function historyMapperArgs(agg: EnrichedAggregateIR): string {
  return maskedHistoryFields(agg).length > 0 ? "r, __histUser" : "r";
}

/** True when the route handler must bind the fail-closed `__histUser`
 *  principal — i.e. when there is at least one masked field to drop. */
export function historyNeedsPrincipal(agg: EnrichedAggregateIR): boolean {
  return maskedHistoryFields(agg).length > 0;
}

/** True when this aggregate's route file needs the history machinery.  Kept
 *  beside the emitters so the route builder and the file-map assembly agree. */
export function aggregateServesHistoryRoute(agg: EnrichedAggregateIR): boolean {
  return historyDiffFields(agg).length > 0;
}
