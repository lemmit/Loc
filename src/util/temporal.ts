// A5 temporal vocabulary — the duration-constructor builtins.
//
// `days(n)` / `hours(n)` / `minutes(n)` / `months(n)` are NOT grammar
// keywords: they parse as ordinary free calls (PostfixChain NameRef +
// CallSuffix) and become `duration` ExprIR nodes during lowering ONLY
// when the name does not resolve to any user declaration (a user
// `function days(...)` shadows the builtin — `resolveCallKind` checks
// user decls first, and only the `"free"` fallback becomes a duration
// node).  `duration` itself is likewise NOT in the grammar's
// `PrimitiveType` rule — it is expression-only by unavailability
// (no storable duration fields in this slice; Postgres `interval`
// columns are a follow-on).
//
// Lives in `src/util/` because BOTH the language layer (type-system,
// validators) and the IR layer (lowering) need the runtime vocabulary,
// and `language/` may not take a runtime import from `ir/`.

export const DURATION_UNITS = ["days", "hours", "minutes", "months"] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number];

/** The duration unit `name` names, or undefined for a non-builtin name. */
export function durationUnitOf(name: string): DurationUnit | undefined {
  return (DURATION_UNITS as readonly string[]).includes(name) ? (name as DurationUnit) : undefined;
}

/** Milliseconds per ABSOLUTE duration unit.  `months` is deliberately
 *  absent — a calendar month has no fixed millisecond width, which is
 *  why the validator (`loom.duration-months-position`) restricts
 *  `months(...)` to direct `datetime ± months(n)` position where each
 *  backend takes its native calendar path (JS `setMonth`, .NET
 *  `AddMonths`, java `Period`, python `relativedelta`, Elixir shift). */
export const DURATION_UNIT_MS: Record<Exclude<DurationUnit, "months">, number> = {
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
};
