// -------------------------------------------------------------------------
// Domain-service body checks — the no-infra contract, rev. 4 tiers.
// (domain-services.md; the `reading` tier is Slice 1.)
//
// A `domainService` operation falls into a tier DERIVED from its body
// (`classifyDomainServiceTier` — never a stamped field):
//
//   - `pure`     — no infrastructure (the pure-calculator floor).
//   - `reading`  — runs READ-ONLY repository queries (`Accounts.byHolder(h)`,
//                  `Repo.find/findAll/run`), lowered to a `repo-read` Call.
//                  Reads are ALLOWED; writes / commits stay forbidden.
//   - `mutating` — mutates the aggregates the orchestrator PASSES IN, by
//                  calling a MUTATING operation on an aggregate PARAMETER
//                  (`src.withdraw(amount)`).  ALLOWED (Slice 2): a domain
//                  service has no `this`, so the param-op call — a `method-call`
//                  whose receiver is an aggregate param — is the legitimate
//                  mutating mechanism; it never reaches the `no-mutation` gate
//                  below (that fires only on a `this`-rooted assign/add/remove
//                  STATEMENT, which has no `this` to write).  The orchestrator
//                  (workflow) loads the params and owns the single commit.
//
// What this leaf enforces:
//
//   - `emit`                              → loom.domain-service-no-emit
//   - `assign` / `add` / `remove`         → loom.domain-service-no-mutation
//     (a domain service has no `this`; a `this`-rooted write is a hard error —
//      this is STILL rejected.  Mutating a passed-in aggregate via its OWN
//      operation, `param.op(...)`, is a `method-call`, not an assign/add/remove
//      STATEMENT, so it is NOT caught here — that's the allowed mutating tier.)
//   - a repository WRITE call (save/insert/update/delete/add/remove/commit)
//                                         → loom.domain-service-no-repo-write
//     (repository READS — find/findAll/run/named-find — are ALLOWED:
//      they lower to a `repo-read` Call and never reach this `method-call`
//      gate, the `reading` tier)
//   - a call whose receiver names a `workflow` in the context
//                                         → loom.domain-service-no-workflow-start
//   - a `reading`/`mutating` domain service called from an aggregate
//     operation/create/destroy
//                                         → loom.domain-service-infra-call-from-aggregate
//     (pure services are exempt — they carry no infrastructure)
//
// Plus the anemic-domain WARNING when every operation takes exactly one
// aggregate-typed parameter (loom.domain-service-single-aggregate).
//
// `extern`/`api`-call rejection rides a future target-resolution slice.
// -------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  ExprIR,
  OperationIR,
  ParamIR,
  StmtIR,
} from "../../types/loom-ir.js";
import { aggregateOpResolver, classifyDomainServiceTier } from "../../util/domain-service-tier.js";
import { isWriteMethod } from "../../util/repo-methods.js";
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
  // The infra-call gate is a cross-declaration check — it needs the set of
  // NON-pure services, then a scan of every aggregate body for a call
  // into one.  Run it once per context after the per-service checks.
  checkInfraCallsFromAggregates(ctx, diags);
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
          message: `${where}: '${stmt.target.segments.join(".")} ${assignVerb(stmt.kind)}' writes to aggregate state, but a domain service has no 'this' to mutate.  To mutate a passed-in aggregate, call its own operation (e.g. 'src.withdraw(amount)') — the mutating tier; or return a value instead.`,
          source,
        });
        break;
    }
    // Expression-level infra:
    //   - a repository WRITE call (`Accounts.save(x)`) — a `method-call` whose
    //     receiver names a repository and whose member is a write verb.  READS
    //     are not seen here: a recognised repository read lowers to a `repo-read`
    //     Call, not a `method-call`, so it never reaches this gate (the
    //     `reading` tier).
    //   - a call whose receiver names a `workflow` (starting the application
    //     layer from the domain layer).
    forEachStmtExpr(stmt, (e) => {
      const recvName = callReceiverName(e);
      if (!recvName) return;
      if (repoNames.has(recvName)) {
        // Only a WRITE method is rejected — reads are allowed (and have already
        // been lowered to `repo-read` Calls, so a `method-call` on a repo here
        // is either a write verb or an unknown one; gate on the write verbs).
        if (e.kind === "method-call" && isWriteMethod(e.member)) {
          diags.push({
            severity: "error",
            code: "loom.domain-service-no-repo-write",
            message: `${where}: repository WRITE '${recvName}.${e.member}(…)' is not allowed — a domain service may run read-only queries (the 'reading' tier), but persistence writes (save/insert/update/delete/add/remove/commit) belong to the orchestrator (workflow / command handler).`,
            source,
          });
        }
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

/** `loom.domain-service-infra-call-from-aggregate` — a `reading` (or
 *  `mutating`) domain service runs infrastructure (a repository read / a write),
 *  so it must be orchestrated by the application layer (workflow / command
 *  handler), never called from inside an aggregate `operation`/`create`/`destroy`
 *  body.  PURE services are exempt (no infrastructure).  The
 *  closest analog is the UI mutating-command gate (`ui-checks.ts`
 *  `checkMissingEffectMarker`). */
function checkInfraCallsFromAggregates(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  // The set of NON-pure (reading/mutating) services in this context — only a
  // call into one of these is gated.  Resolving the tier needs the aggregate-op
  // resolver so a `mutating` service (calls `param.op(...)` on a passed-in
  // aggregate) is recognised as non-pure — otherwise it would be misclassified
  // `pure` and wrongly admitted inside aggregate bodies.
  const resolveAggOp = aggregateOpResolver(ctx);
  const nonPure = new Set<string>();
  for (const svc of ctx.domainServices) {
    if (svc.operations.some((op) => classifyDomainServiceTier(op, resolveAggOp) !== "pure")) {
      nonPure.add(svc.name);
    }
  }
  if (nonPure.size === 0) return;

  const flag = (where: string, source: string, call: Extract<ExprIR, { kind: "call" }>): void => {
    const ref = call.serviceRef;
    if (!ref || !nonPure.has(ref.service)) return;
    diags.push({
      severity: "error",
      code: "loom.domain-service-infra-call-from-aggregate",
      message: `${where}: call to domain service '${ref.service}.${ref.op}(…)' reaches beyond the aggregate boundary (a repository read, or mutating other passed-in aggregates), which the domain layer may not do from inside an aggregate operation.  Move the call into the orchestrating workflow / command handler, which loads the aggregates and owns the commit.`,
      source,
    });
  };

  for (const agg of ctx.aggregates) {
    for (const op of [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])]) {
      scanAggregateOp(ctx, agg, op, flag);
    }
  }
}

function scanAggregateOp(
  ctx: BoundedContextIR,
  agg: AggregateIR,
  op: OperationIR,
  flag: (where: string, source: string, call: Extract<ExprIR, { kind: "call" }>) => void,
): void {
  const where = `aggregate '${agg.name}' operation '${op.name}'`;
  const source = `${ctx.name}/${agg.name}.${op.name}`;
  for (const stmt of op.statements) {
    forEachStmtExpr(stmt, (e) => {
      if (e.kind === "call" && e.callKind === "domain-service") flag(where, source, e);
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

/** When `e` is a `method-call` whose receiver is a bare `ref`, return that
 *  receiver's name (so a use of a repository / workflow by name can be
 *  detected); otherwise undefined. */
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
