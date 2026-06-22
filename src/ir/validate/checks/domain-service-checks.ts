// -------------------------------------------------------------------------
// Domain-service body checks — the strict no-infra contract
// (domain-services.md, v1 Shape A, the resolvable floor).
//
// A `domainService` is a stateless container of NON-mutating, pure
// calculator operations.  Their bodies reuse the aggregate-operation
// `Statement` grammar, but the domain-service layer forbids any reach
// into infrastructure or aggregate state.  This leaf enforces the
// subset that is cleanly resolvable from the lowered IR:
//
//   - `emit`                              → loom.domain-service-no-emit
//   - `assign` / `add` / `remove`         → loom.domain-service-no-mutation
//     (a domain service has no `this`; a `this`-rooted write is a hard error)
//   - a call whose receiver names a `repository` in the context
//                                         → loom.domain-service-no-repo
//   - a call whose receiver names a `workflow` in the context
//                                         → loom.domain-service-no-workflow-start
//
// Plus the anemic-domain WARNING when every operation takes exactly one
// aggregate-typed parameter (loom.domain-service-single-aggregate) — the
// behaviour could live on that aggregate instead.
//
// Parameter-operation-mutation (`from.withdraw(x)`) is DEFERRED to Phase
// 2 (Shape B) — it needs target-resolution of the method's callee, which
// v1 does not attempt.  `extern` / `api`-call rejection rides the same
// future target-resolution slice; the stable codes are reserved here for
// when it lands.
// -------------------------------------------------------------------------

import type {
  BoundedContextIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  ExprIR,
  ParamIR,
  StmtIR,
} from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

export function validateDomainServices(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  const repoNames = new Set(ctx.repositories.map((r) => r.name));
  const workflowNames = new Set(ctx.workflows.map((w) => w.name));
  for (const svc of ctx.domainServices) {
    for (const op of svc.operations) {
      checkOperationBody(ctx, svc, op, repoNames, workflowNames, diags);
    }
    checkAnemic(ctx, svc, diags);
  }
}

function checkOperationBody(
  ctx: BoundedContextIR,
  svc: DomainServiceIR,
  op: DomainServiceOperationIR,
  repoNames: ReadonlySet<string>,
  workflowNames: ReadonlySet<string>,
  diags: LoomDiagnostic[],
): void {
  const source = `${ctx.name}/${svc.name}.${op.name}`;
  const where = `domainService '${svc.name}' operation '${op.name}'`;
  for (const stmt of op.body) {
    // Statement-level infra: emit + this-rooted writes.
    switch (stmt.kind) {
      case "emit":
        diags.push({
          severity: "error",
          code: "loom.domain-service-no-emit",
          message: `${where}: 'emit ${stmt.eventName}' is not allowed — a stateless domain service has no identity to attribute an event to.  Emit from the aggregate or workflow that owns the fact.`,
          source,
        });
        break;
      case "assign":
      case "add":
      case "remove":
        diags.push({
          severity: "error",
          code: "loom.domain-service-no-mutation",
          message: `${where}: '${stmt.target.segments.join(".")} ${assignVerb(stmt.kind)}' writes to aggregate state, but a domain service has no 'this' to mutate (v1 is the pure-calculator floor).  Return a value instead.`,
          source,
        });
        break;
    }
    // Expression-level infra: a call whose receiver names a repository or
    // workflow in this context.  Repository loads are the application's
    // job (the orchestrator loads and passes materialised aggregates in);
    // a domain service may not reach the application layer.
    forEachStmtExpr(stmt, (e) => {
      const recvName = callReceiverName(e);
      if (!recvName) return;
      if (repoNames.has(recvName)) {
        diags.push({
          severity: "error",
          code: "loom.domain-service-no-repo",
          message: `${where}: call on repository '${recvName}' is not allowed — loading is the application's job.  The orchestrator (workflow / command handler) loads and passes the aggregate in.`,
          source,
        });
      } else if (workflowNames.has(recvName)) {
        diags.push({
          severity: "error",
          code: "loom.domain-service-no-workflow-start",
          message: `${where}: starting workflow '${recvName}' is not allowed — a domain-layer service cannot reach into the application layer.`,
          source,
        });
      }
    });
  }
}

/** `loom.domain-service.single-aggregate` — soft warning when every
 *  operation takes exactly one aggregate-typed parameter (the behaviour
 *  could be an `operation` on that aggregate instead). */
function checkAnemic(ctx: BoundedContextIR, svc: DomainServiceIR, diags: LoomDiagnostic[]): void {
  if (svc.operations.length === 0) return;
  const everyOpSingleAggregate = svc.operations.every(
    (op) => op.params.length === 1 && isAggregateParam(op.params[0]!),
  );
  if (!everyOpSingleAggregate) return;
  diags.push({
    severity: "warning",
    code: "loom.domain-service-single-aggregate",
    message: `domainService '${svc.name}': every operation takes a single aggregate parameter — consider declaring the behaviour as an 'operation' on that aggregate instead of a domain service.`,
    source: `${ctx.name}/${svc.name}`,
  });
}

function isAggregateParam(p: ParamIR): boolean {
  return p.type.kind === "entity";
}

function assignVerb(kind: "assign" | "add" | "remove"): string {
  return kind === "assign" ? ":= ..." : kind === "add" ? "+= ..." : "-= ...";
}

/** When `e` is a `call`/`method-call` whose receiver is a bare `ref`,
 *  return that receiver's name (so a use of a repository / workflow by
 *  name can be detected); otherwise undefined. */
function callReceiverName(e: ExprIR): string | undefined {
  if (e.kind === "method-call" && e.receiver.kind === "ref") return e.receiver.name;
  return undefined;
}

/** Visit every sub-expression reachable from a statement. */
function forEachStmtExpr(stmt: StmtIR, visit: (e: ExprIR) => void): void {
  switch (stmt.kind) {
    case "precondition":
    case "requires":
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
    case "expression":
      walkExpr(stmt.expr, visit);
      break;
    case "return":
      walkExpr(stmt.value, visit);
      break;
  }
}
