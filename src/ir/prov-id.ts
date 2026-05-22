// ---------------------------------------------------------------------------
// Provenance identity + presence helpers.
//
// Pure, dependency-free (no `node:crypto`) so the browser playground
// (`web/`) can import the lowering pipeline.  `snapshotId` is a stable,
// commit-independent hash of a write-site's source location + target;
// the git commit is stamped once into the `.loomsnap.json` envelope at
// artefact-build time, never per node.
// ---------------------------------------------------------------------------

import type { ProvSite, SystemIR, StmtIR } from "./loom-ir.js";

/** FNV-1a 32-bit, rendered as 8 lowercase hex chars.  Deterministic and
 *  pure — adequate for content-addressing source spans, not for crypto. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Content-addressed id for one write-site rule snapshot: a hash of the
 *  target field + the RHS expression structure.  A rule that changes gets
 *  a new id; an unchanged rule keeps its id across builds and captures, so
 *  different code versions reference different snapshots only where the
 *  rule actually changed.  (Easiest scheme; can later be swapped for a
 *  capture-versioned or AST-canonical id without touching call sites.) */
export function snapshotIdFor(args: {
  type: string;
  field: string;
  exprText: string;
}): string {
  const key = `${args.type}.${args.field}::${args.exprText}`;
  return fnv1a(key);
}

/** An instrumented write-site: an assign/add/remove statement carrying a
 *  resolved provenance snapshot. */
export type ProvStmt = Extract<StmtIR, { kind: "assign" | "add" | "remove" }> & {
  prov: ProvSite;
};

/** A statement carries provenance iff it is an instrumented write-site. */
export function stmtHasProv(s: StmtIR): s is ProvStmt {
  return (
    (s.kind === "assign" || s.kind === "add" || s.kind === "remove") &&
    s.prov !== undefined
  );
}

/** True iff any aggregate operation in the system contains an
 *  instrumented provenanced write-site.  Drives emission of the runtime
 *  SDK + the `.loomsnap.json` artefact. */
export function hasAnyProvSite(sys: SystemIR): boolean {
  for (const mod of sys.modules) {
    for (const ctx of mod.contexts) {
      for (const agg of ctx.aggregates) {
        for (const op of agg.operations) {
          if (op.statements.some(stmtHasProv)) return true;
        }
      }
    }
  }
  return false;
}

/** Same predicate over a bare context list (legacy single-deployable
 *  mode + the per-deployable TS emit path). */
export function contextsHaveProvSite(
  contexts: { aggregates: { operations: { statements: StmtIR[] }[] }[] }[],
): boolean {
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      for (const op of agg.operations) {
        if (op.statements.some(stmtHasProv)) return true;
      }
    }
  }
  return false;
}
