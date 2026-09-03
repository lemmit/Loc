import { diagMessage } from "../../../diagnostics/messages.js";
import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  OperationIR,
  StmtIR,
} from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

// ---------------------------------------------------------------------------
// Capability stamp-read-before-flush check (capability-stamp-dedup).
//
// The `auditable` capability stamps four managed audit columns —
// createdAt / updatedAt / createdBy / updatedBy — at PERSIST time (the .NET
// AuditableInterceptor at SaveChanges; the Java AuditingEntityListener at
// flush).  Both backends are persist-time, so a value an action stamps is NOT
// yet populated while that action's body runs: it lands when the unit of work
// flushes, after the body returns.
//
// Reading such a not-yet-populated stamp inside the very action that triggers
// it would observe a null/default in production but might appear to work under
// an operation-time prototype — a silent semantic gap.  This check turns it
// into a compile error so the persist-time move stays safe:
//
//   - CREATE action body: reading ANY of the four audit fields is an error
//     (none are set until the create flush completes).
//   - UPDATE / mutating operation body: reading updatedAt / updatedBy is an
//     error (not applied until THIS flush).  Reading createdAt / createdBy is
//     FINE — they were set by the prior create-flush.
//
// "Is auditable" is derived (no IR field): `(agg.contextStamps ?? []).length`.
// The audit field set is fixed by the capability, so the names are constants.
// ---------------------------------------------------------------------------

/** The four managed audit columns the `auditable` capability stamps. */
const CREATE_STAMP_FIELDS = ["createdAt", "createdBy", "updatedAt", "updatedBy"] as const;
/** Fields applied only at THIS flush (not readable mid-update). */
const UPDATE_STAMP_FIELDS = ["updatedAt", "updatedBy"] as const;

/** True when the expression is a read of `this.<field>` for one of `fields` —
 *  either the bare `this-prop` ref form (`createdAt`) or the explicit member
 *  form (`this.createdAt`).  Stamp fields are scalar managed columns, so a
 *  read is always one of these two leaf shapes. */
function readsField(e: ExprIR, fields: readonly string[]): boolean {
  if (e.kind === "ref" && e.refKind === "this-prop" && fields.includes(e.name)) return true;
  if (e.kind === "member" && e.receiver.kind === "this" && fields.includes(e.member)) return true;
  return false;
}

/** Walk every expression that is READ inside one statement.  Assignment /
 *  collection-mutation TARGETS (the LHS path) are NOT reads — only their RHS
 *  value expressions are.  Mirrors the read positions the other body checks
 *  traverse. */
function walkReadExprs(s: StmtIR, visit: (e: ExprIR) => void): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      walkExpr(s.expr, visit);
      break;
    case "assign":
    case "add":
    case "remove":
      walkExpr(s.value, visit);
      break;
    case "emit":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
    case "call":
      for (const a of s.args) walkExpr(a, visit);
      break;
    case "return":
      walkExpr(s.value, visit);
      break;
    case "variant-match":
      // Wave 2 packet 2.3 (M-T6.50 class) — this arm was missing, so a
      // stamp-field read nested inside a `variant-match` arm/else body
      // silently never tripped the read-before-flush gate.
      walkExpr(s.subject, visit);
      for (const a of s.arms) for (const st of a.body) walkReadExprs(st, visit);
      for (const st of s.elseBody ?? []) walkReadExprs(st, visit);
      break;
    default: {
      const _exhaustive: never = s;
      void _exhaustive;
    }
  }
}

/** Scan one action body for a read of any field in `fields`; push one
 *  diagnostic per offending action (first offending read suffices). */
function scanBody(
  statements: readonly StmtIR[],
  fields: readonly string[],
  found: () => void,
): void {
  for (const s of statements) {
    let hit = false;
    walkReadExprs(s, (e) => {
      if (readsField(e, fields)) hit = true;
    });
    if (hit) {
      found();
      return;
    }
  }
}

export function validateStampReadsBeforeFlush(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
  for (const agg of ctx.aggregates as EnrichedAggregateIR[]) {
    const isAuditable = (agg.contextStamps?.length ?? 0) > 0;
    if (!isAuditable) continue;

    // CREATE actions — none of the four are populated until the create flush.
    for (const c of agg.creates ?? []) {
      scanBody(c.statements, CREATE_STAMP_FIELDS, () => {
        diags.push({
          severity: "error",
          code: "loom.stamp-read-before-flush",
          message: diagMessage("loom.stamp-read-before-flush#aggregate-create-reads", {
            name: agg.name,
            cName: c.name,
            createStampFields: CREATE_STAMP_FIELDS.join("/"),
          }),
          source: `${ctx.name}/${agg.name}`,
        });
      });
    }

    // Mutating operations — updatedAt/updatedBy are applied at THIS flush, so
    // they are not yet readable in-body.  createdAt/createdBy were set by the
    // prior create-flush and ARE readable.
    for (const op of agg.operations as OperationIR[]) {
      scanBody(op.statements, UPDATE_STAMP_FIELDS, () => {
        diags.push({
          severity: "error",
          code: "loom.stamp-read-before-flush",
          message: diagMessage("loom.stamp-read-before-flush#aggregate-operation-reads", {
            name: agg.name,
            opName: op.name,
            updateStampFields: UPDATE_STAMP_FIELDS.join("/"),
          }),
          source: `${ctx.name}/${agg.name}`,
        });
      });
    }
  }
}
