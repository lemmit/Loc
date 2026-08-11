// Where an aggregate operation's `requires` gate is EMITTED — the split that
// keeps authorization out of the domain entity.
//
// A `requires` gate is not an invariant.  `precondition` (→ 422) asserts that
// the aggregate is in a valid state for this command; `requires` (→ 403)
// asserts that the *caller* may issue it.  The second is an application-layer
// concern: an entity that evaluates it has to take a `currentUser` parameter,
// which makes it uncallable from a saga, a seed, or a timer without
// fabricating a principal.
//
// Both spellings of the gate arrive here as the same thing.  A HEADER gate
// (`operation close() requires <e> { … }`) is lowered to a synthetic `requires`
// StmtIR prepended to the body (`lower-members.ts`), so by the time a generator
// sees an operation, header and first-body forms are indistinguishable — a
// LEADING RUN of `requires` statements.  That run is what hoists.
//
// Only the leading run.  A `requires` further down a body sits after statements
// that may have mutated the aggregate or bound `let`s it reads; hoisting it
// would change WHEN it evaluates, not just where it lives.  Those stay put and
// keep rendering through each backend's `render-stmt.ts` exactly as before.
//
// Derive, don't stamp (CLAUDE.md): this is a pure function of `op.statements`,
// so it is computed on demand at each emission site rather than stored as an
// IR field that a construction site could forget to set.

import { type OperationIR, type StmtIR, stmtUsesCurrentUser } from "../types/loom-ir.js";

/** A `requires` statement, narrowed out of the general `StmtIR` union. */
export type RequiresStmtIR = Extract<StmtIR, { kind: "requires" }>;

/** An operation's statements split at the end of its leading `requires` run.
 *
 *  `gates` are the hoistable authorization checks (emitted by the CALLER —
 *  route handler / controller / context function — post-load and before the
 *  `when` state gate); `body` is everything the domain method still runs. */
export interface SplitGates {
  gates: RequiresStmtIR[];
  body: StmtIR[];
}

/** Split the leading run of `requires` statements off an operation body.
 *
 *  Returns empty `gates` (and the untouched statement list as `body`) for an
 *  ungated operation, so every call site can use this unconditionally. */
export function splitLeadingGates(statements: readonly StmtIR[]): SplitGates {
  let i = 0;
  while (i < statements.length && statements[i]!.kind === "requires") i++;
  return {
    gates: statements.slice(0, i) as RequiresStmtIR[],
    body: statements.slice(i),
  };
}

/** The gates a caller must evaluate before invoking `op` on a loaded aggregate. */
export function operationGates(op: OperationIR): RequiresStmtIR[] {
  return splitLeadingGates(op.statements).gates;
}

/** The statements the domain method still runs, with the hoisted gates removed. */
export function operationBody(op: OperationIR): StmtIR[] {
  return splitLeadingGates(op.statements).body;
}

/** True when the operation's REMAINING body (post-hoist) references
 *  `currentUser` — the predicate that decides whether the emitted domain
 *  method still needs a `currentUser` parameter.
 *
 *  Distinct from `operationUsesCurrentUser`, which answers the same question
 *  for the whole statement list (gates included) and is still the right
 *  predicate at a CALL site that has to decide whether to resolve a principal
 *  at all. */
export function operationBodyUsesCurrentUser(op: OperationIR): boolean {
  return operationBody(op).some(stmtUsesCurrentUser);
}

/** True when any hoisted gate of `op` references `currentUser` — so the caller
 *  must bind a principal before evaluating them. */
export function operationGatesUseCurrentUser(op: OperationIR): boolean {
  return operationGates(op).some(stmtUsesCurrentUser);
}
