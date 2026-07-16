// Feliz `match await` async-effect shape classifier (async-actions-and-effects.md
// Stage 2, M-T6.15).  Shared by the IR validator (`store-checks.ts`, which gates
// the UNSUPPORTED shapes as `loom.feliz-async-effect-unsupported`) and the Feliz
// generator (`src/generator/feliz/`, which RENDERS the supported shape).  Keeping
// the classification in one pure IR-level place means the gate and the renderer
// can never drift — a shape the generator emits is exactly the shape the gate
// lets through, and vice versa.
//
// Supported shape (M-T6.15 + the "harder shapes" extension):
//   `match await <api>.<Agg>.<op>(args?) { <Variant> b => { … } … else? => { … } }`
//   — an aggregate INSTANCE operation (0-or-more args), one OR MORE named arms
//   (each binding a success aggregate variant OR an error variant), and an
//   OPTIONAL `else`.  The trigger id is sourced from the host page's route `:id`,
//   so the ONLY remaining gated case is a host with no route id (a component or a
//   non-`:id` page) — checked in `store-checks.ts`, not here.  A subject that
//   isn't an aggregate instance op (a collection op, a workflow, a non-aggregate
//   receiver) also stays gated.

import type { ExprIR, StmtIR, TypeIR } from "../types/loom-ir.js";

/** The `variant-match` statement flavour this classifier inspects. */
type VariantMatchStmt = Extract<StmtIR, { kind: "variant-match" }>;

/** One arm of the awaited match — a named union variant (success aggregate or
 *  error) bound to a local and running a body.  The generator resolves the wire
 *  tag / decoder / error classification from `varType` (it has the context
 *  payloads); the classifier stays pure IR and passes the arm through. */
export interface FelizAsyncArm {
  /** The variant's declared type — an `entity` (success aggregate) or an error
   *  reference.  `variantTag(varType)` yields the wire discriminator. */
  varType: TypeIR;
  /** The arm's binding local (`o`, `r`), if it binds one. */
  binding?: string;
  /** The arm body statements (run when this variant matched). */
  body: StmtIR[];
  /** The lowered `isError` hint (the generator refines it against the owning
   *  context's `error` payloads, which are authoritative — this is a fallback). */
  isError: boolean;
}

/** The fully-resolved facts a supported async effect carries — enough for the
 *  Feliz generator to project the trigger/result Msg cases, the update arms, the
 *  request body, and the tagged-union decoder without re-walking the statement. */
export interface FelizAsyncEffectShape {
  /** Aggregate the awaited instance op lives on — the route target
   *  (`/api/<plural>/<id>/<op>`).  `Order` in the canonical example. */
  opAggregate: string;
  /** The awaited operation name (`confirm`). */
  op: string;
  /** The awaited call's argument expressions, in source order — index-aligned
   *  with the op's params (empty for a 0-arg op).  Rendered + Thoth-encoded into
   *  the POST body by the generator. */
  args: ExprIR[];
  /** The named match arms — one or more, each a success or error variant. */
  arms: FelizAsyncArm[];
  /** The `else` body, or undefined when the source had no `else` (the generator
   *  then reduces the non-matching / error outcome to a no-op). */
  elseBody?: StmtIR[];
}

/** Classification result — either the resolved supported shape, or an honest
 *  reason the statement is gated on Feliz. */
export type FelizAsyncEffectClass =
  | { supported: true; shape: FelizAsyncEffectShape }
  | { supported: false; reason: string };

/** Detect the awaited instance op in a variant-match subject: a method-call
 *  whose receiver is `<apiParam>.<Agg>` (Pattern B) or a bare `<Agg>` (Pattern
 *  E).  Args are allowed now (op-with-params) and returned for the generator to
 *  encode.  Mirrors the aggregate arms of the generator's shared
 *  `tryDetectApiHook`, but stays pure IR (no generator dep) so the validator can
 *  call it. */
function detectAwaitedInstanceOp(
  subject: VariantMatchStmt["subject"],
  apiParamNames: ReadonlySet<string>,
  aggregateNames: ReadonlySet<string>,
): { aggregate: string; op: string; args: ExprIR[] } | null {
  if (subject.kind !== "method-call") return null;
  const recv = subject.receiver;
  // Pattern B: `<apiParam>.<Agg>.<op>(args?)`
  if (
    recv.kind === "member" &&
    recv.receiver.kind === "ref" &&
    apiParamNames.has(recv.receiver.name) &&
    aggregateNames.has(recv.member)
  ) {
    return { aggregate: recv.member, op: subject.member, args: subject.args };
  }
  // Pattern E: `<Agg>.<op>(args?)` (no api-param prefix)
  if (recv.kind === "ref" && aggregateNames.has(recv.name)) {
    return { aggregate: recv.name, op: subject.member, args: subject.args };
  }
  return null;
}

/** Classify a frontend `match await` (`variant-match`) statement against the
 *  Feliz supported shape.  Pure — takes only name sets, so both the IR validator
 *  and the generator invoke it identically.  Accepts an aggregate instance op
 *  (with or without params), one or more named arms (success or error), and an
 *  optional `else`.  The host's route-id availability is NOT checked here (the
 *  generator + `store-checks.ts` own that), so a supported shape here may still
 *  be gated for a routeless host. */
export function classifyFelizAsyncEffect(
  stmt: VariantMatchStmt,
  apiParamNames: ReadonlySet<string>,
  aggregateNames: ReadonlySet<string>,
): FelizAsyncEffectClass {
  const detected = detectAwaitedInstanceOp(stmt.subject, apiParamNames, aggregateNames);
  if (!detected) {
    return {
      supported: false,
      reason:
        "the awaited subject is not an aggregate instance operation " +
        "(`<api>.<Agg>.<op>(…)`) — a non-aggregate subject (a collection op, a " +
        "workflow, a static call) is not rendered on Feliz yet",
    };
  }
  if (stmt.arms.length === 0) {
    return {
      supported: false,
      reason: "it has no match arms — an async effect must name at least one variant",
    };
  }
  return {
    supported: true,
    shape: {
      opAggregate: detected.aggregate,
      op: detected.op,
      args: detected.args,
      arms: stmt.arms.map((a) => ({
        varType: a.varType,
        binding: a.binding,
        body: a.body,
        isError: a.isError === true,
      })),
      elseBody: stmt.elseBody,
    },
  };
}
