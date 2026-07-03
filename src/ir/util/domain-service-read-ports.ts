// Read-port derivation for a `reading`-tier domain-service operation
// (domain-services.md rev. 4, Slice 1).
//
// A `reading` domain-service operation runs read-only repository queries
// (lowered to `repo-read` Calls).  Its generated declaration gains one
// READ-PORT parameter per DISTINCT repository it reads, and the orchestrating
// caller (a `workflow`) supplies the matching handle at the call site.  Both
// the per-backend declaration emitter AND the call-site wiring need the SAME
// ordered set of ports — so the derivation lives here, in `ir/util/` (the layer
// its consumers share, per pipeline-checklist.md), DERIVED from the lowered body
// (CLAUDE.md "derive, don't stamp"): there is no stamped read-port field.
//
// A port is identified by its `repo` (the repository name, e.g. `Accounts`) and
// the `aggregate` it serves (e.g. `Account`).  Ports are returned in
// first-read order, de-duplicated by repository name, so a body that reads the
// same repository twice declares one parameter and the caller passes one handle.
import type { DomainServiceOperationIR, ExprIR } from "../types/loom-ir.js";
import { walkStmtExprsDeep } from "./walk.js";

/** One read-port a `reading` operation consumes — the repository it reads and
 *  the aggregate that repository serves. */
export interface ReadPort {
  /** The repository name (`Accounts`). */
  repo: string;
  /** The aggregate the repository serves (`Account`) — the generated repo
   *  class is `<aggregate>Repository`. */
  aggregate: string;
}

/** The ordered, de-duplicated set of read-ports a domain-service operation
 *  consumes — one per distinct repository read in its body, in first-read
 *  order.  Empty for a `pure` operation (no `repo-read` Call), which is why a
 *  pure service's declaration / call site stays byte-identical. */
export function readPortsForOperation(op: DomainServiceOperationIR): ReadPort[] {
  const byRepo = new Map<string, ReadPort>();
  for (const stmt of op.body) {
    walkStmtExprsDeep(stmt, (e: ExprIR) => {
      if (e.kind === "call" && e.callKind === "repo-read" && e.repoRead) {
        const { repo, aggregate } = e.repoRead;
        if (!byRepo.has(repo)) byRepo.set(repo, { repo, aggregate });
      }
    });
  }
  return [...byRepo.values()];
}
