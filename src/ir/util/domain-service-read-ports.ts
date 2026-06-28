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
import type { DomainServiceOperationIR, ExprIR, StmtIR } from "../types/loom-ir.js";

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
    forEachStmtExpr(stmt, (e) => {
      if (e.kind === "call" && e.callKind === "repo-read" && e.repoRead) {
        const { repo, aggregate } = e.repoRead;
        if (!byRepo.has(repo)) byRepo.set(repo, { repo, aggregate });
      }
    });
  }
  return [...byRepo.values()];
}

/** Visit every sub-expression reachable from a statement (read-port derivation
 *  only needs to find every `repo-read` Call anywhere in the body). */
function forEachStmtExpr(stmt: StmtIR, visit: (e: ExprIR) => void): void {
  switch (stmt.kind) {
    case "precondition":
    case "requires":
    case "expression":
    case "let":
      walkExpr(stmt.expr, visit);
      break;
    case "assign":
    case "add":
    case "remove":
      walkExpr(stmt.value, visit);
      break;
    case "emit":
      for (const f of stmt.fields) walkExpr(f.value, visit);
      break;
    case "call":
      for (const a of stmt.args) walkExpr(a, visit);
      break;
    case "return":
      walkExpr(stmt.value, visit);
      break;
  }
}

/** Visit `e` and every sub-expression. */
function walkExpr(e: ExprIR | undefined, visit: (e: ExprIR) => void): void {
  if (!e) return;
  visit(e);
  switch (e.kind) {
    case "method-call":
      walkExpr(e.receiver, visit);
      for (const a of e.args) walkExpr(a, visit);
      break;
    case "member":
      walkExpr(e.receiver, visit);
      break;
    case "binary":
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      break;
    case "ternary":
      walkExpr(e.cond, visit);
      walkExpr(e.then, visit);
      walkExpr(e.otherwise, visit);
      break;
    case "unary":
      walkExpr(e.operand, visit);
      break;
    case "paren":
      walkExpr(e.inner, visit);
      break;
    case "call":
      for (const a of e.args) walkExpr(a, visit);
      break;
    case "new":
    case "object":
      for (const f of e.fields) walkExpr(f.value, visit);
      break;
    case "lambda":
      walkExpr(e.body, visit);
      break;
  }
}
