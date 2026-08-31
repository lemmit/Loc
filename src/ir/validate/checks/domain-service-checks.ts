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
//   - a body naming a repository that belongs to ANOTHER context
//                                         → loom.domain-service-cross-context-read
//     (see the CROSS-CONTEXT READS header note below)
//
// Plus the anemic-domain WARNING when every operation takes exactly one
// aggregate-typed parameter (loom.domain-service-single-aggregate).
//
// `extern`/`api`-call rejection rides a future target-resolution slice.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
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

export function validateDomainServices(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  allCtxs: readonly BoundedContextIR[],
): void {
  const repoNames = new Set(ctx.repositories.map((r) => r.name));
  const workflowNames = new Set(ctx.workflows.map((w) => w.name));
  const foreignRepos = foreignRepositoryOwners(ctx, allCtxs);
  for (const svc of ctx.domainServices) {
    for (const op of svc.operations) {
      checkOperationBody(ctx, svc, op, repoNames, workflowNames, diags);
      checkCrossContextRepoReads(ctx, svc, op, foreignRepos, diags);
      checkNullableRepoLoad(ctx, svc, op, diags);
    }
    checkAnemic(ctx, svc, diags);
  }
  // The infra-call gate is a cross-declaration check — it needs the set of
  // NON-pure services, then a scan of every aggregate body for a call
  // into one.  Run it once per context after the per-service checks.
  checkInfraCallsFromAggregates(ctx, diags);
}

// -------------------------------------------------------------------------
// The THIRD body kind an optional repository load reaches.
//
// `loom.handler-load-nullable-unsupported` gates a `find …: Agg?` bound in a
// command/query HANDLER body (`api-checks.ts`), and its twin gates the same
// load in a WORKFLOW body (`workflow-checks.ts`) — because no backend emits a
// null guard for it, so the bound name is dereferenced unguarded.  A
// `domainService` operation body is the third place the same load can appear,
// and it was covered by neither: on this checkout the probe emitted an
// UNGUARDED deref on all five backends —
//
//   node    `const a = (await accounts.byHolder(holder)); return a.holder === …`
//           against `byHolder(...): Promise<Account | null>`      → TS18047
//   dotnet  `var a = (await _accounts.ByHolder(holder, ct)); return a.Holder …`
//           against `Task<Account?>`                              → CS8602
//   java    `var a = accountsRepository.byHolder(holder); … a.holder()` → NPE
//   python  `a = (await accounts.by_holder(holder))` then `a.holder` → AttributeError
//   elixir  `a = (case by_holder_account(holder) do … _ -> nil end)` then `a.holder`
//                                                                  → KeyError on nil
//
// A domain-service body is `StmtIR[]` (not the workflow vocabulary), so the
// load is a `let` bound to a `repo-read` CALL rather than a `repo-let`; the
// optionality lives on the FIND's declared return type, not on the let's own
// `type` stamp.  Resolve it through the repository the read names.
//
// `getById` is exempt for the same reason as in the handler gate: it is the
// by-id reconstitution read every backend already renders with a
// not-found/throw path.
// -------------------------------------------------------------------------
function checkNullableRepoLoad(
  ctx: BoundedContextIR,
  svc: DomainServiceIR,
  op: DomainServiceOperationIR,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const stmt of op.body) {
    if (stmt.kind !== "let") continue;
    const call = stmt.expr;
    if (call.kind !== "call" || call.callKind !== "repo-read" || !call.repoRead) continue;
    const { repo: repoName, method } = call.repoRead;
    if (method === "getById") continue;
    const find = ctx.repositories
      .find((r) => r.name === repoName)
      ?.finds.find((f) => f.name === method);
    if (find?.returnType.kind !== "optional") continue;
    const key = `${repoName}.${method}`;
    if (flagged.has(key)) continue;
    flagged.add(key);
    diags.push({
      severity: "error",
      code: "loom.handler-load-nullable-unsupported",
      message: diagMessage("loom.handler-load-nullable-unsupported#domain-service", {
        name: `${svc.name}.${op.name}`,
        repoName,
        method,
      }),
      source: `${ctx.name}/${svc.name}.${op.name}`,
    });
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
          message: diagMessage("loom.domain-service-no-emit", { where, eventName: stmt.eventName }),
          source,
        });
        break;
      case "assign":
      case "add":
      case "remove":
        diags.push({
          severity: "error",
          code: "loom.domain-service-no-mutation",
          message: diagMessage("loom.domain-service-no-mutation", {
            where,
            segments: stmt.target.segments.join("."),
            kind: assignVerb(stmt.kind),
          }),
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
            message: diagMessage("loom.domain-service-no-repo-write", {
              where,
              recvName,
              member: e.member,
            }),
            source,
          });
        } else if (e.kind === "method-call") {
          // A NON-write call on an own-context repository that is STILL a
          // `method-call` here did not lower to a `repo-read` — the detector
          // (`matchRepoRead`) requires the call to be the WHOLE chain
          // (`suffixes.length === 1`), so a read used as a MEMBER RECEIVER
          // (`Accounts.byHolder(h).balance.amount`) never matches.
          //
          // The consequences are the cross-context gate's three, verbatim:
          // `classifyDomainServiceTier` sees no `repo-read` and types the
          // service `pure`, no backend threads a read port in, and every
          // backend renders the bare source name — node `Accounts.byHolder(h)`
          // (TS2304), dotnet `Accounts.ByHolder(h)` (CS0103), java "cannot find
          // symbol", python F821 with no port param at all, and elixir
          // `accounts.by_holder(h).balance` which is not valid Elixir AND
          // splits ONE domainService across two modules (the `let`-bound
          // sibling lands in the reading-tier context module).  The
          // `let`-bound spelling two lines away is threaded correctly, which is
          // what makes this silent rather than obviously broken.
          diags.push({
            severity: "error",
            code: "loom.domain-service-read-unsupported",
            message: diagMessage("loom.domain-service-read-unsupported", {
              where,
              recvName,
              member: e.member,
            }),
            source,
          });
        }
      } else if (workflowNames.has(recvName)) {
        diags.push({
          severity: "error",
          code: "loom.domain-service-no-workflow-start",
          message: diagMessage("loom.domain-service-no-workflow-start", { where, recvName }),
          source,
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// CROSS-CONTEXT READS — `loom.domain-service-cross-context-read`.
//
// The `reading` tier is scoped to the service's OWN context, and nothing said
// so.  `lowerDomainService` indexes `serviceRepos` from `env.ctx.members`
// alone, so a body naming a repository of ANOTHER context can never lower to a
// `repo-read` Call: it stays a `method-call` on a `ref` with
// `refKind: "unknown"`.  That has three consequences, all silent:
//
//   1. `classifyDomainServiceTier` sees no `repo-read` and calls the op `pure`,
//   2. `readPortsForOperation` yields no port, so no backend threads a
//      repository handle in, and
//   3. every backend renders the unresolved receiver verbatim.
//
// Re-verified 2026-08-23 on a two-context system (`context A`'s
// `domainService Naming { operation isFree(r: string): bool { return
// Customers.byName(r) == null } }` reading `context B`'s `Customers`) —
// `ddd parse` reports ZERO diagnostics and all five backends emit a dangling
// identifier:
//
//   TS     — `domain/services.ts`: `return Customers.byName(r) === null;`
//            in a file importing nothing → TS2304.
//   .NET   — `Domain/Services/Naming.cs`: `Customers.ByName(r)` → CS0103.
//   Java   — `domain/services/Naming.java`: `Customers.byName(r)`
//            → "cannot find symbol".
//   Python — `app/domain/services/naming.py`: `Customers.by_name(r)`
//            → NameError / F821.
//   Phoenix— `lib/<app>/domain/services/naming.ex`:
//            `is_nil(customers.by_name(r))` → "undefined variable customers"
//            (the ref is snake-cased into a local that was never bound).
//
// So this is one MODEL-level shape that no backend supports, not five
// per-backend gaps — the same call the repo's parity policy makes for
// `loom.resource-op-outside-workflow` (#2618): reject at the source rather
// than let five emitters fail five different silent ways.
//
// SCOPE.  The gate keys on a bare `ref` that (a) did not resolve
// (`refKind: "unknown"`, so a param/local shadowing the name is never flagged)
// and (b) names a repository declared in some OTHER context of the model —
// never one this context declares, so a same-name repository in the service's
// own context keeps resolving locally and is untouched.  Both read and write
// verbs are caught: the sibling `loom.domain-service-no-repo-write` gate is
// context-LOCAL (it keys on `ctx.repositories`), so a cross-context
// `Customers.save(x)` reaches only this one.
//
// NOT in scope: an unresolved receiver that names nothing at all
// (`Ghost.foo(r)`) is equally silent today, but it is a general
// unresolved-name hole across every body kind, not the domain-service context
// boundary this gate describes.
// ---------------------------------------------------------------------------

/** repository name → the OTHER context that declares it (first wins).  Names
 *  this context declares are excluded, so a locally-resolving read is never a
 *  candidate. */
function foreignRepositoryOwners(
  ctx: BoundedContextIR,
  allCtxs: readonly BoundedContextIR[],
): ReadonlyMap<string, string> {
  const local = new Set(ctx.repositories.map((r) => r.name));
  const owners = new Map<string, string>();
  for (const other of allCtxs) {
    if (other.name === ctx.name) continue;
    for (const repo of other.repositories) {
      if (local.has(repo.name) || owners.has(repo.name)) continue;
      owners.set(repo.name, other.name);
    }
  }
  return owners;
}

/** `loom.domain-service-cross-context-read` — see the header note above. */
function checkCrossContextRepoReads(
  ctx: BoundedContextIR,
  svc: DomainServiceIR,
  op: DomainServiceOperationIR,
  foreignRepos: ReadonlyMap<string, string>,
  diags: LoomDiagnostic[],
): void {
  if (foreignRepos.size === 0) return;
  const where = `domainService '${svc.name}' operation '${op.name}'`;
  const source = `${ctx.name}/${svc.name}.${op.name}`;
  // One diagnostic per repository, not per mention — a body reading the same
  // foreign repository twice states the same boundary problem once.
  const flagged = new Set<string>();
  for (const stmt of op.body) {
    forEachStmtExpr(stmt, (e) => {
      if (e.kind !== "ref" || e.refKind !== "unknown") return;
      const otherContext = foreignRepos.get(e.name);
      if (!otherContext || flagged.has(e.name)) return;
      flagged.add(e.name);
      diags.push({
        severity: "error",
        code: "loom.domain-service-cross-context-read",
        message: diagMessage("loom.domain-service-cross-context-read", {
          where,
          recvName: e.name,
          ownContext: ctx.name,
          otherContext,
        }),
        source,
      });
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
      message: diagMessage("loom.domain-service-infra-call-from-aggregate", {
        where,
        service: ref.service,
        op: ref.op,
      }),
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
    message: diagMessage("loom.domain-service-single-aggregate", { name: svc.name }),
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
