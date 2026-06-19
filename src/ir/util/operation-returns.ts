// ---------------------------------------------------------------------------
// Shared predicate for exception-less operation `or`-union returns
// (exception-less.md A3).  Lives in `ir/util` so both the IR validator
// (`validate/checks/structural-checks.ts`) and the Elixir/Ash generator
// (`generator/elixir/operation-returns-ash-emit.ts`) read ONE source of truth
// for "can the Ash foundation emit this returning op yet" — the generator may
// import down into `ir/`, but the validator may not import up into the
// generator, so the rule cannot live on the generator side.
// ---------------------------------------------------------------------------

import type { OperationIR } from "../types/loom-ir.js";

/** A *return-dominant* returning op: it declares an `or`-union return type and
 *  every statement is a `return` or a plain `let`.  This is the first slice the
 *  Ash foundation can emit as a generic action (a generic action has no
 *  changeset, so mutation-then-return — `assign`/`add`/`remove`/`emit` — and
 *  `requires`/`precondition` guards stay deferred on Ash; the vanilla
 *  foundation handles those via its tagged-tuple context fn). */
export function isReturnDominantOp(op: OperationIR): boolean {
  if (!op.returnType) return false;
  return op.statements.every((s) => s.kind === "return" || s.kind === "let");
}

/** A returning op the Ash foundation can emit as a generic action.  Broadens
 *  the return-dominant slice to *in-memory* mutation-then-return: the run fn
 *  loads the record and a `field := value` (`assign`) struct-updates it in
 *  place (`%{record | field: …}`, same as the vanilla foundation — no Ash
 *  changeset / no persistence beyond the response), and `precondition` /
 *  `requires` guards raise.  Still deferred (→ host on `foundation: vanilla`):
 *  `emit` (PubSub), `add`/`remove` (association metadata), and bare expression
 *  statements — those need machinery the generic action's run fn doesn't carry. */
export function isAshReturningOpEmittable(op: OperationIR): boolean {
  if (!op.returnType) return false;
  return op.statements.every(
    (s) =>
      s.kind === "return" ||
      s.kind === "let" ||
      s.kind === "assign" ||
      s.kind === "precondition" ||
      s.kind === "requires",
  );
}
