// Domain-service tier classifier (domain-services.md rev. 4).
//
// A `domainService` operation falls into one of three tiers, DERIVED from its
// body — never stamped as a field on `DomainServiceOperationIR` (CLAUDE.md
// "derive, don't stamp"; the canonical analog is page *kind*, classified on
// demand by `classifyPage`):
//
//   - `pure`     — no infrastructure at all (the pure-calculator floor).
//   - `reading`  — runs read-only repository queries (`Accounts.byHolder(h)`,
//                  `Repo.find/findAll/run`), lowered to a `repo-read` Call.
//                  Writes / commits stay forbidden; loading the *target*
//                  aggregates + the commit stay in the workflow orchestrator.
//   - `mutating` — writes aggregate state / persistence (an `assign`/`add`/
//                  `remove` statement, or a repository WRITE).  Classified here
//                  so the validator + future emitters can switch on it, but the
//                  mutating EMISSION is a LATER slice — this slice still rejects
//                  mutation via `loom.domain-service-no-mutation`.
//
// One shared classifier, consumed by the validator now and the per-backend
// emitters later.  It reads only the lowered IR (a `repo-read` Call is the
// fully-resolved marker of a read), so it never re-recognises the AST.
import type { DomainServiceOperationIR, ExprIR, StmtIR } from "../types/loom-ir.js";

export type DomainServiceTier = "pure" | "reading" | "mutating";

/** Derive the {@link DomainServiceTier} of a domain-service operation from its
 *  lowered body.  Mutation outranks reading outranks pure (a body that both
 *  reads and writes is `mutating`). */
export function classifyDomainServiceTier(op: DomainServiceOperationIR): DomainServiceTier {
  let reads = false;
  for (const stmt of op.body) {
    // Statement-level mutation: a `this`-rooted write has no `this` on a
    // service, but the IR shape (assign/add/remove) is the unambiguous signal.
    if (stmt.kind === "assign" || stmt.kind === "add" || stmt.kind === "remove") {
      return "mutating";
    }
    forEachStmtExpr(stmt, (e) => {
      // A `repo-read` Call anywhere in the body marks the operation `reading`.
      // (A repository WRITE has no dedicated callKind this slice — it is left
      // unresolved at lowering and caught by the validator's repo-write gate
      // off the AST shape; statement-level assign/add/remove above is the
      // mutation signal the classifier keys on.)
      if (e.kind === "call" && e.callKind === "repo-read") reads = true;
    });
  }
  return reads ? "reading" : "pure";
}

/** Visit every sub-expression reachable from a statement (the classifier only
 *  needs to find a `repo-read` Call anywhere in the body). */
function forEachStmtExpr(stmt: StmtIR, visit: (e: ExprIR) => void): void {
  switch (stmt.kind) {
    case "precondition":
    case "requires":
    case "expression":
      walkExpr(stmt.expr, visit);
      break;
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
