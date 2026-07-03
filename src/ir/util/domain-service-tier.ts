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
//   - `mutating` — mutates the aggregates the orchestrator PASSES IN, by
//                  calling a MUTATING operation on an aggregate PARAMETER
//                  (`src.withdraw(amount)`).  A domain service has no `this`, so
//                  the param-op call is the real mutating mechanism (rev. 4
//                  §"What the IR needs to carry": "calls a mutating op on an
//                  aggregate param ⇒ `mutating`").  The orchestrator (workflow)
//                  loads the params and owns the single commit; the service
//                  never writes to a repository.
//
// One shared classifier, consumed by the validator now and the per-backend
// emitters later.  It reads only the lowered IR (a `repo-read` Call is the
// fully-resolved marker of a read; a `method-call` on a param ref of entity
// type, resolved to a mutating aggregate operation, is the mutation marker), so
// it never re-recognises the AST.
import type { DomainServiceOperationIR, ExprIR, OperationIR } from "../types/loom-ir.js";
import { walkStmtExprsDeep } from "./walk.js";

export type DomainServiceTier = "pure" | "reading" | "mutating";

/** The resolvers `computeSaves` needs to derive the aggregate ARGS a called
 *  `mutating` domain service writes (domain-services.md rev. 4, Slice 2): one to
 *  find a service operation by `(service, op)`, one to decide whether an
 *  aggregate op mutates its receiver ({@link aggregateOpResolver}).  Built once
 *  per workflow from the context's lowered aggregates + domain services. */
export interface SaveResolver {
  resolveServiceOp: (service: string, op: string) => DomainServiceOperationIR | undefined;
  resolveAggOp: AggregateOpResolver;
}

/** Resolve an aggregate operation by `(aggregateName, opName)` so the classifier
 *  can decide whether a `param.op(...)` call mutates its receiver.  Built from
 *  the enclosing `BoundedContextIR` at the call site
 *  ({@link aggregateOpResolver}); `undefined` ⇒ the classifier can't see the
 *  aggregate operations and falls back to read/pure (the param-op-mutation tier
 *  is then simply not detected — never a false `mutating`). */
export type AggregateOpResolver = (
  aggregateName: string,
  opName: string,
) => OperationIR | undefined;

/** True when an aggregate `operation` writes its own (`this`-rooted) state — an
 *  `assign` / `add` / `remove` statement anywhere in its body.  This is the same
 *  this-write shape the domain-service body checks key on; a `domainService` op
 *  that CALLS such an operation on an aggregate parameter is `mutating`. */
export function isMutatingOperation(op: OperationIR): boolean {
  return op.statements.some(
    (st) => st.kind === "assign" || st.kind === "add" || st.kind === "remove",
  );
}

/** Build an {@link AggregateOpResolver} over a context's aggregates.  A
 *  `param.op(...)` receiver carries `receiverType: { kind: "entity", name }`, so
 *  the resolver looks the aggregate up by that name and finds the operation —
 *  searching `operations` plus the lifecycle `creates` / `destroys` (a mutating
 *  `create`/`destroy` op called on a param still mutates). */
export function aggregateOpResolver(ctx: {
  aggregates: readonly {
    name: string;
    operations: OperationIR[];
    creates?: OperationIR[];
    destroys?: OperationIR[];
  }[];
}): AggregateOpResolver {
  return (aggregateName, opName) => {
    const agg = ctx.aggregates.find((a) => a.name === aggregateName);
    if (!agg) return undefined;
    return [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])].find(
      (o) => o.name === opName,
    );
  };
}

/** Derive the {@link DomainServiceTier} of a domain-service operation from its
 *  lowered body.  Mutation outranks reading outranks pure (a body that both
 *  reads and mutates is `mutating`).
 *
 *  `resolveAggOp` (optional) lets the classifier see aggregate operations so it
 *  can detect param-op mutation (`src.withdraw(amount)` — a call to a mutating
 *  op on an aggregate parameter).  Without it the classifier sees only
 *  reads/pure; passing one ({@link aggregateOpResolver} over the enclosing
 *  context) unlocks the `mutating` tier. */
export function classifyDomainServiceTier(
  op: DomainServiceOperationIR,
  resolveAggOp?: AggregateOpResolver,
): DomainServiceTier {
  // The aggregate-typed parameters of this op — a `mutating` param-op call must
  // target one of these (mutation is on the PASSED-IN aggregates).
  const aggregateParams = new Map<string, string>(); // paramName -> aggregateName
  for (const p of op.params) {
    if (p.type.kind === "entity") aggregateParams.set(p.name, p.type.name);
  }

  let reads = false;
  for (const stmt of op.body) {
    // Statement-level mutation: a `this`-rooted write has no `this` on a service
    // (the validator rejects it via `loom.domain-service-no-mutation`), but the
    // IR shape (assign/add/remove) is still an unambiguous `mutating` signal —
    // kept so the tier the validator/emitters switch on agrees with the gate.
    if (stmt.kind === "assign" || stmt.kind === "add" || stmt.kind === "remove") {
      return "mutating";
    }
    let mutates = false;
    walkStmtExprsDeep(stmt, (e: ExprIR) => {
      // A `repo-read` Call anywhere in the body marks the operation `reading`.
      // (A repository WRITE has no dedicated callKind this slice — it is left
      // unresolved at lowering and caught by the validator's repo-write gate
      // off the AST shape.)
      if (e.kind === "call" && e.callKind === "repo-read") reads = true;
      // A `param.op(args)` call where `param` is an aggregate parameter and the
      // resolved aggregate operation mutates its own state ⇒ this service
      // mutates the passed-in aggregate (rev. 4 mutating tier).
      if (resolveAggOp && isParamOpMutation(e, aggregateParams, resolveAggOp)) {
        mutates = true;
      }
    });
    if (mutates) return "mutating";
  }
  return reads ? "reading" : "pure";
}

/** The aggregate PARAMETERS a `mutating` domain-service operation writes — the
 *  names of the entity params on which the body calls a mutating aggregate
 *  operation (`source.withdraw(amount)` ⇒ `{ "source" }`).  This is the precise
 *  mutation set the orchestrator must persist: a workflow that passes its loaded
 *  `s`/`d` aggregates into `Transfer.run(s, d, amount)` saves exactly the args
 *  bound to these params (domain-services.md rev. 4, the `mutating` tier; the
 *  orchestrator-owned commit).  Without a resolver the set is empty (the
 *  classifier can't see aggregate ops — never a false positive).  Same param-op
 *  recognition as {@link classifyDomainServiceTier}; a read-only arg is never
 *  included. */
export function mutatedParamNames(
  op: DomainServiceOperationIR,
  resolveAggOp: AggregateOpResolver,
): Set<string> {
  const aggregateParams = new Map<string, string>(); // paramName -> aggregateName
  for (const p of op.params) {
    if (p.type.kind === "entity") aggregateParams.set(p.name, p.type.name);
  }
  const mutated = new Set<string>();
  for (const stmt of op.body) {
    walkStmtExprsDeep(stmt, (e: ExprIR) => {
      if (
        e.kind === "method-call" &&
        e.receiver.kind === "ref" &&
        e.receiver.refKind === "param" &&
        isParamOpMutation(e, aggregateParams, resolveAggOp)
      ) {
        mutated.add(e.receiver.name);
      }
    });
  }
  return mutated;
}

/** Is `e` a `param.op(args)` call that mutates a passed-in aggregate?  `param`
 *  must be a bare `ref` to an aggregate-typed parameter of this operation, and
 *  the resolved aggregate operation must write its own state
 *  ({@link isMutatingOperation}). */
function isParamOpMutation(
  e: ExprIR,
  aggregateParams: ReadonlyMap<string, string>,
  resolveAggOp: AggregateOpResolver,
): boolean {
  if (e.kind !== "method-call") return false;
  if (e.receiver.kind !== "ref" || e.receiver.refKind !== "param") return false;
  const aggName = aggregateParams.get(e.receiver.name);
  if (!aggName) return false;
  const target = resolveAggOp(aggName, e.member);
  return target !== undefined && isMutatingOperation(target);
}
