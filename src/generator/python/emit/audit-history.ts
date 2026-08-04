// ---------------------------------------------------------------------------
// Entity history — the READ side of the `audited` command trail, Python /
// FastAPI.  (docs/audit.md; the shape + diff boundary + masking rules live at
// IR level in `src/ir/util/audit-history.ts`, shared with every backend, so the
// wire bytes match `test/behavioral/wire-golden/audit-history.json` by
// construction rather than by re-derivation here.)
//
// Three emitted pieces, mirroring the Hono port one-for-one:
//
//   1. `app/audit/history.py` — the `AuditEntry` / `AuditFieldChange` response
//      models and the two pure helpers.  Shape-only, so one copy serves every
//      audited aggregate.
//   2. A per-aggregate `_<agg>_audit_entry(row)` mapper in the routes module —
//      this is where `mask unless` composes in, because the mapper is the only
//      place a CALLER enters the picture (the snapshots were written
//      server-side inside the command's transaction, with no caller to mask
//      against, so they hold raw values for every field).
//   3. The `history(id)` repository query over `audit_records`.
//
// A masked field's change entry is DROPPED, never emitted-and-redacted: a
// redacted-but-present entry still discloses THAT the field changed, when, and
// by whom.  Fail-closed on a null principal, exactly like `to_wire_masked`.
// ---------------------------------------------------------------------------

import type { EnrichedAggregateIR } from "../../../ir/types/loom-ir.js";
import { maskedHistoryFields, unmaskedHistoryFields } from "../../../ir/util/audit-history.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { renderPyExpr } from "../render-expr.js";

/** Name of the per-aggregate row → entry mapper emitted into the routes file. */
export function pyHistoryMapperName(agg: EnrichedAggregateIR): string {
  return `_${snake(agg.name)}_audit_entry`;
}

/** `app/audit/history.py` — the shared response models + pure helpers. */
export function renderPyAuditHistoryModule(): string {
  return lines(
    `"""Entity history — the read side of the \`audited\` command trail.`,
    ``,
    `One entry per SUCCESSFUL command (a failed command's transaction rolls back,`,
    `taking its audit row with it), so this answers "what changed", not "who`,
    `tried".  \`changes\` is derived from the row's two snapshots at READ time and`,
    `never stored."""`,
    ``,
    `import json`,
    ``,
    `from pydantic import BaseModel, RootModel`,
    ``,
    ``,
    `class AuditFieldChange(BaseModel):`,
    `    """One field-level change between an entry's two snapshots.`,
    ``,
    `    \`before\`/\`after\` are opaque JSON — whatever the aggregate's wire DTO held`,
    `    for that key.  Both are nullable and both are meaningful: a \`create\` has`,
    `    no \`before\`, a \`destroy\` no \`after\`."""`,
    ``,
    `    field: str`,
    `    before: object | None = None`,
    `    after: object | None = None`,
    ``,
    ``,
    `class AuditEntry(BaseModel):`,
    `    """One entry in an entity's history."""`,
    ``,
    `    auditId: str`,
    `    at: str`,
    `    action: str`,
    `    operationId: str`,
    `    actor: object | None = None`,
    `    correlationId: str | None = None`,
    `    changes: list[AuditFieldChange]`,
    ``,
    ``,
    `class AuditEntryListResponse(RootModel[list[AuditEntry]]):`,
    `    pass`,
    ``,
    ``,
    `def audit_snapshot_value(snapshot: object | None, key: str) -> object | None:`,
    `    """Read one key out of a snapshot.`,
    ``,
    `    A missing key and an explicit null are the same thing here — a \`create\``,
    `    row has no \`before\` object at all, and its fields must read as None`,
    `    rather than raise."""`,
    `    if not isinstance(snapshot, dict):`,
    `        return None`,
    `    return snapshot.get(key)`,
    ``,
    ``,
    `def audit_value_changed(before: object | None, after: object | None) -> bool:`,
    `    """Did this key actually move between the two snapshots?`,
    ``,
    `    Structural comparison via JSON with sorted keys, so a value object or a`,
    `    containment array compares by CONTENT rather than by identity — which is`,
    `    what a reader expects of "changed"."""`,
    `    return json.dumps(before, sort_keys=True, default=str) != json.dumps(`,
    `        after, sort_keys=True, default=str`,
    `    )`,
    ``,
  );
}

/** The per-aggregate mapper.  Unmasked diff fields run through one loop; each
 *  masked field gets its own predicate-guarded block. */
export function renderPyHistoryMapper(agg: EnrichedAggregateIR): string {
  const unmasked = unmaskedHistoryFields(agg);
  const masked = maskedHistoryFields(agg);
  const body: (string | null)[] = [
    `def ${pyHistoryMapperName(agg)}(row: AuditRecordRow) -> dict[str, object]:`,
    `    changes: list[dict[str, object]] = []`,
  ];
  if (unmasked.length > 0) {
    const keys = unmasked.map((f) => JSON.stringify(f.name)).join(", ");
    body.push(
      `    for key in (${keys}${unmasked.length === 1 ? "," : ""}):`,
      `        __b = audit_snapshot_value(row.before, key)`,
      `        __a = audit_snapshot_value(row.after, key)`,
      `        if audit_value_changed(__b, __a):`,
      `            changes.append({"field": key, "before": __b, "after": __a})`,
    );
  }
  if (masked.length > 0) {
    // The ambient principal, read through the NON-raising getter — an
    // unauthenticated caller yields None and every masked entry drops.
    body.push(`    _mask_user = current_user()`);
  }
  for (const f of masked) {
    // The SAME `mask unless` predicate the entity read applies via
    // `to_wire_masked`, so history can never disclose a field the entity read
    // would have hidden.
    const pred = renderPyExpr(f.maskUnless!, { thisName: "self", currentUserExpr: "_mask_user" });
    const key = JSON.stringify(f.name);
    body.push(
      `    # \`${f.name}\`: \`mask unless\` — the change entry is DROPPED, not redacted.`,
      `    # A redacted-but-present entry would still disclose that it changed, when,`,
      `    # and by whom, which is the disclosure the mask exists to prevent.`,
      `    if _mask_user is not None and (${pred}):`,
      `        __b = audit_snapshot_value(row.before, ${key})`,
      `        __a = audit_snapshot_value(row.after, ${key})`,
      `        if audit_value_changed(__b, __a):`,
      `            changes.append({"field": ${key}, "before": __b, "after": __a})`,
    );
  }
  body.push(
    `    return {`,
    `        "auditId": row.audit_id,`,
    `        "at": iso(row.at),`,
    `        "action": row.action,`,
    `        "operationId": row.operation_id,`,
    `        "actor": row.actor,`,
    `        "correlationId": row.correlation_id,`,
    `        "changes": changes,`,
    `    }`,
  );
  return lines(...body);
}

/** The `history(id)` repository query — filtered on the `(target_type,
 *  target_id)` pair the write side indexes, oldest first. */
export function renderPyHistoryRepoMethod(agg: EnrichedAggregateIR): string {
  return lines(
    `    async def history(self, id: ${agg.name}Id) -> Sequence[AuditRecordRow]:`,
    `        __stmt = (`,
    `            select(AuditRecordRow)`,
    `            .where(`,
    `                AuditRecordRow.target_type == ${JSON.stringify(agg.name)},`,
    `                AuditRecordRow.target_id == str(id),`,
    `            )`,
    `            .order_by(AuditRecordRow.at)`,
    `        )`,
    `        return (await self._session.execute(__stmt)).scalars().all()`,
  );
}
