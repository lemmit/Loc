// A5 temporal ExprIR helpers — shared by the queryable gate
// (src/ir/validate/checks/shared.ts), the Hono/Drizzle predicate lowerer
// and the TS expression renderer (src/generator/typescript/*).  Pure,
// type-only view over the lowered IR; no language-layer imports.

import type { ExprIR } from "../types/loom-ir.js";

export type DurationExprIR = Extract<ExprIR, { kind: "duration" }>;

/** The duration-constructor node `e` is (paren-transparently), or null.
 *  Only DIRECT constructor operands unwrap here — a duration-typed `let`
 *  ref or a `duration ± duration` binary is not a constructor node and
 *  returns null (the queryable gate deliberately admits only the direct
 *  constructor form, since that is the only shape the Drizzle lowerer
 *  translates to `make_interval`). */
export function durationCtorOperand(e: ExprIR): DurationExprIR | null {
  if (e.kind === "paren") return durationCtorOperand(e.inner);
  return e.kind === "duration" ? e : null;
}

/** `durationCtorOperand`, narrowed to the calendar-relative `months` unit. */
export function monthsCtorOperand(e: ExprIR): DurationExprIR | null {
  const d = durationCtorOperand(e);
  return d && d.unit === "months" ? d : null;
}

/** Best-effort "this expression is datetime-typed" probe over lowered IR —
 *  member accesses carry `memberType`, refs carry `type`, `now` is the
 *  datetime literal, and a lowered binary carries `resultType`.  Synthetic
 *  nodes without type stamps conservatively answer false. */
export function isDatetimeTypedIR(e: ExprIR): boolean {
  const isDt = (t: { kind: string; name?: string } | undefined): boolean =>
    t?.kind === "primitive" && t.name === "datetime";
  switch (e.kind) {
    case "paren":
      return isDatetimeTypedIR(e.inner);
    case "literal":
      return e.lit === "now";
    case "member":
      return isDt(e.memberType);
    case "ref":
      return isDt(e.type);
    case "binary":
      return isDt(e.resultType);
    case "ternary":
      return isDatetimeTypedIR(e.then) && isDatetimeTypedIR(e.otherwise);
    default:
      return false;
  }
}
