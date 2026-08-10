// ---------------------------------------------------------------------------
// The BACKEND validation-message catalog (M-T1.11).
//
// An authored `message "…"` on an `invariant` / field `check` / `precondition`
// already reaches the wire twice: as the default English text on
// `errors[].message`, and as a stable content-hash `code` (`msg.<hash>`, via
// `messageCode()`) a client can localise by.  What was missing is the other
// half of "localise by code" — a CATALOG the SERVER can resolve the code
// against, so a `fr` request gets French from the same backend rather than
// forcing every client to ship its own copy of every rule's text.
//
// This module is the ONE place that decides WHICH messages a backend ships and
// WHAT key each one has.  All five backends build their catalog from
// `collectWireValidationMessages`, so the five catalogs are the same set of
// entries with the same keys — the cross-backend parity the wire `code` already
// promised (`test/generator/i18n/backend-message-catalog.test.ts` pins it), and
// the same keys `.loom/messages.en.json` carries for translators.
//
// SCOPE — the WIRE boundary, deliberately.  A messaged rule surfaces in two
// places: the wire validator (422 `errors[]`) and the domain floor (the
// `DomainError` / `DomainException` a tripped rule throws inside the aggregate).
// This slice localises the WIRE half only — the five wire-validator emitters
// (`zod-refine.ts`, `dotnet/validator-emit.ts`, `java/emit/validator.ts`,
// `python/emit/wire-constraints.ts`, `elixir/vanilla/changeset-invariant-emit.ts`)
// attach the code, and each backend's 422 serializer resolves it.  The domain
// floor still renders the authored default at every locale; localising it means
// carrying the code THROUGH the thrown error on all five backends, which is its
// own slice.  The catalog is scoped to match, so it holds no entry the runtime
// cannot resolve (the dead-catalog class `user-visible-slot-coverage.test.ts`
// gates on the UI side).
//
// The membership rule is the emitters' own: a rule is in the catalog iff it
// carries a `message` AND `classifyForWire` admits it under one of the three
// request shapes a wire validator is built for —
//
//   * `Create<Agg>Request`  — available = the create-input fields
//   * `<Op><Agg>Request`    — available = the operation's params, over
//                             `[...agg.invariants, ...preconditions]` (SYS-1)
//   * `<Vo>Request`         — available = the value object's own fields
//
// which mirrors `routes-builder.ts` / `validator-emit.ts` / `emit/validator.ts`
// exactly.  A `@server-only` rule, or one reaching state no request body
// carries, therefore contributes nothing — matching what the emitters do.
// ---------------------------------------------------------------------------

import { createInputFields } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  InvariantIR,
  OperationIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import { classifyForWire } from "../../ir/validate/invariant-classify.js";
import { messageCode } from "../../util/message-code.js";

/** One catalog entry — the stable wire `code` and its source-language text. */
export interface ValidationMessage {
  /** `msg.<hash>` — identical to the `errors[].code` the validators attach. */
  readonly code: string;
  /** The authored English, the fallback a missing translation resolves to. */
  readonly text: string;
}

/** Lift an operation's `precondition` statements to invariants — the same
 *  normalisation every wire-validator emitter does before classifying. */
function preconditionsAsInvariants(op: OperationIR): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") out.push({ expr: s.expr, source: s.source, message: s.message });
  }
  return out;
}

/** Record every messaged, wire-translatable rule in `invariants` (classified
 *  against `available`) into `into`. */
function take(
  invariants: readonly InvariantIR[],
  available: ReadonlySet<string>,
  into: Map<string, string>,
): void {
  for (const inv of invariants) {
    if (!inv.message) continue;
    if (!classifyForWire(inv, { available })) continue;
    // Same text ⇒ same content hash ⇒ same entry; the repeated write collapses
    // one message authored on several rules into a single catalog line.
    into.set(messageCode(inv.message.text), inv.message.text);
  }
}

function takeAggregate(agg: AggregateIR, into: Map<string, string>): void {
  take(agg.invariants, new Set(createInputFields(agg).map((f) => f.name)), into);
  for (const op of agg.operations) {
    take(
      [...agg.invariants, ...preconditionsAsInvariants(op)],
      new Set(op.params.map((p) => p.name)),
      into,
    );
  }
}

function takeValueObject(vo: ValueObjectIR, into: Map<string, string>): void {
  take(vo.invariants, new Set(vo.fields.map((f) => f.name)), into);
}

/** Every authored validation message the WIRE validators of `contexts` can
 *  surface, keyed by its stable `messageCode()` hash and sorted by key so the
 *  emitted catalog is byte-stable across runs. */
export function collectWireValidationMessages(
  contexts: readonly BoundedContextIR[],
): ValidationMessage[] {
  const byCode = new Map<string, string>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) takeAggregate(agg, byCode);
    for (const vo of ctx.valueObjects) takeValueObject(vo, byCode);
  }
  return [...byCode.keys()].sort().map((code) => ({ code, text: byCode.get(code)! }));
}

/** True when `contexts` carry any wire-surfaced authored message — the single
 *  gate every backend takes for its catalog + lookup emission.  False ⇒ the
 *  generated project is byte-identical to pre-catalog output. */
export function hasWireValidationMessages(contexts: readonly BoundedContextIR[]): boolean {
  return collectWireValidationMessages(contexts).length > 0;
}
