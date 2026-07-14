// Feliz `match await` async-effect shape classifier (async-actions-and-effects.md
// Stage 2, M-T6.15).  Shared by the IR validator (`store-checks.ts`, which gates
// the UNSUPPORTED shapes as `loom.feliz-async-effect-unsupported`) and the Feliz
// generator (`src/generator/feliz/`, which RENDERS the supported shape).  Keeping
// the classification in one pure IR-level place means the gate and the renderer
// can never drift — a shape the generator emits is exactly the shape the gate
// lets through, and vice versa.
//
// v1 supported shape (the only one the Feliz MVU renderer handles):
//   `match await <api>.<Agg>.<op>() { <Agg> b => { … } else => { … } }`
//   — a 0-argument aggregate INSTANCE operation, exactly one SUCCESS arm binding
//   an aggregate variant, and an `else`.  Everything else (a real multi-variant
//   union, an op with params, no `else`, a component/non-`:id` host) stays gated.

import type { StmtIR } from "../types/loom-ir.js";

/** The `variant-match` statement flavour this classifier inspects. */
type VariantMatchStmt = Extract<StmtIR, { kind: "variant-match" }>;

/** The fully-resolved facts a supported v1 async effect carries — enough for the
 *  Feliz generator to project the trigger/result Msg cases, the update arms, and
 *  the tagged-union decoder without re-walking the statement. */
export interface FelizAsyncEffectShape {
  /** Aggregate the awaited instance op lives on — the route target
   *  (`/api/<plural>/<id>/<op>`).  `Project` in the canonical example. */
  opAggregate: string;
  /** The awaited operation name (`reserve`). */
  op: string;
  /** The single success arm's aggregate variant — the record decoded off the
   *  `type`-tagged 200 body (`Decoders.<agg>`).  Same as `opAggregate` in v1. */
  successAggregate: string;
  /** The success arm's binding local (`p`), if the arm binds one. */
  binding?: string;
  /** The success arm's body statements (run under `(Ok (Some p))`). */
  successBody: StmtIR[];
  /** The `else` body statements (run under BOTH `(Ok None)` and `(Error _)` in
   *  v1 — a non-matching tag and a thrown/non-2xx both fall to the else). */
  elseBody: StmtIR[];
}

/** Classification result — either the resolved supported shape, or an honest
 *  reason the statement is gated on Feliz. */
export type FelizAsyncEffectClass =
  | { supported: true; shape: FelizAsyncEffectShape }
  | { supported: false; reason: string };

/** Detect the awaited instance op in a variant-match subject: a 0-argument
 *  method-call whose receiver is `<apiParam>.<Agg>` (Pattern B) or a bare
 *  `<Agg>` (Pattern E).  A non-empty arg list means the op takes params — not a
 *  v1 shape — so it returns null there too.  Mirrors the aggregate arms of the
 *  generator's shared `tryDetectApiHook`, but stays pure IR (no generator dep)
 *  so the validator can call it. */
function detectAwaitedInstanceOp(
  subject: VariantMatchStmt["subject"],
  apiParamNames: ReadonlySet<string>,
  aggregateNames: ReadonlySet<string>,
): { aggregate: string; op: string } | null {
  if (subject.kind !== "method-call") return null;
  if (subject.args.length > 0) return null; // op params → v1 gate
  const recv = subject.receiver;
  // Pattern B: `<apiParam>.<Agg>.<op>()`
  if (
    recv.kind === "member" &&
    recv.receiver.kind === "ref" &&
    apiParamNames.has(recv.receiver.name) &&
    aggregateNames.has(recv.member)
  ) {
    return { aggregate: recv.member, op: subject.member };
  }
  // Pattern E: `<Agg>.<op>()` (no api-param prefix)
  if (recv.kind === "ref" && aggregateNames.has(recv.name)) {
    return { aggregate: recv.name, op: subject.member };
  }
  return null;
}

/** Classify a frontend `match await` (`variant-match`) statement against the
 *  Feliz v1 supported shape.  Pure — takes only name sets, so both the IR
 *  validator and the generator invoke it identically. */
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
        "the awaited subject is not a 0-argument aggregate instance operation " +
        "(`<api>.<Agg>.<op>()`) — an op with params or a non-aggregate subject is not rendered yet",
    };
  }
  if (stmt.arms.length !== 1) {
    return {
      supported: false,
      reason:
        `it has ${stmt.arms.length} match arms — v1 renders exactly one SUCCESS arm plus an ` +
        "`else` (a genuine multi-variant union is not rendered yet)",
    };
  }
  const arm = stmt.arms[0]!;
  if (arm.isError) {
    return {
      supported: false,
      reason: "its single arm is an error variant — v1 renders one SUCCESS arm plus an `else`",
    };
  }
  if (arm.varType.kind !== "entity" || !aggregateNames.has(arm.varType.name)) {
    return {
      supported: false,
      reason:
        "its success arm does not bind an aggregate variant — v1 decodes the success outcome " +
        "as an aggregate record",
    };
  }
  if (!stmt.elseBody || stmt.elseBody.length === 0) {
    return {
      supported: false,
      reason: "it has no `else` arm — v1 requires an `else` to reduce the non-success outcome",
    };
  }
  return {
    supported: true,
    shape: {
      opAggregate: detected.aggregate,
      op: detected.op,
      successAggregate: arm.varType.name,
      binding: arm.binding,
      successBody: arm.body,
      elseBody: stmt.elseBody,
    },
  };
}
