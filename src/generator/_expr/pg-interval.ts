// A5 temporal — the Postgres spelling of `datetime ± days/hours/minutes(n)`.
//
// FOUR emitters write this same interval as SQL TEXT: the drizzle repository
// predicate, the MikroORM `raw()` FilterQuery fragment, the Dapper `whereToSql`
// renderer, and the Ecto fragment.  They agreed by coincidence, in four copies
// of the same three-row table, which is exactly the shape that drifts — so the
// table lives here once, beside `pg-intrinsics.ts`, which is the same seam for
// the scalar-intrinsic snippets.
//
// (Java's HQL and EF Core's LINQ are NOT consumers: neither writes Postgres
// text, they hand a typed expression to a translator.)

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { type DurationExprIR, durationCtorOperand } from "../../ir/util/temporal.js";
import type { DurationUnit } from "../../util/temporal.js";

/** Postgres `make_interval` named-argument spelling per duration unit.  Note
 *  `minutes` is `mins` — the function's parameter name, not the unit's. */
export const MAKE_INTERVAL_ARG: Record<DurationUnit, string> = {
  days: "days",
  hours: "hours",
  minutes: "mins",
};

/** A `datetime ± duration` comparison operand, split into the datetime side
 *  and the interval that is added to it. */
export interface TemporalInterval {
  /** `+` or `-` — the operator between the datetime side and the interval. */
  op: "+" | "-";
  /** The datetime side (a column, a bound param, `now()`, …). */
  operand: ExprIR;
  /** The duration constructor supplying the interval. */
  duration: DurationExprIR;
}

/** Recognise `datetime ± days/hours/minutes(n)` (and the commuted
 *  `duration + datetime`), or null if `e` is not that shape.
 *
 *  Only the DIRECT constructor operand form is admitted — paren-transparent,
 *  but `dt + (days(1) + hours(2))` is not, because no emitter has an arm for a
 *  composite duration and `firstNonQueryableNode` refuses it at phase ⑦.  The
 *  two must admit exactly the same set, which is what keeps the compile-time
 *  gate honest about what the emitters can actually lower. */
export function temporalInterval(e: ExprIR): TemporalInterval | null {
  const inner = e.kind === "paren" ? temporalInterval(e.inner) : null;
  if (inner) return inner;
  if (e.kind !== "binary" || (e.op !== "+" && e.op !== "-")) return null;
  const rightDur = durationCtorOperand(e.right);
  // `duration + datetime` commutes; `duration - datetime` is not a datetime.
  const leftDur = e.op === "+" ? durationCtorOperand(e.left) : null;
  const duration = rightDur ?? leftDur;
  const operand = rightDur ? e.left : leftDur ? e.right : null;
  // `days(1) + hours(2)` — both sides constructors — is a composite, not an
  // offset applied to a datetime.
  if (!duration || !operand || durationCtorOperand(operand)) return null;
  return { op: e.op, operand, duration };
}
