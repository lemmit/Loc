// A5 temporal vocabulary — the duration-constructor builtins.
//
// `days(n)` / `hours(n)` / `minutes(n)` are NOT grammar
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

export const DURATION_UNITS = ["days", "hours", "minutes"] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number];

/** The duration unit `name` names, or undefined for a non-builtin name. */
export function durationUnitOf(name: string): DurationUnit | undefined {
  return (DURATION_UNITS as readonly string[]).includes(name) ? (name as DurationUnit) : undefined;
}

/** Milliseconds per duration unit.  `duration` is an ABSOLUTE span — every
 *  unit has a fixed millisecond width, so every backend renders it uniformly
 *  (JS ms-numbers, .NET `TimeSpan`, java `Duration`, python `timedelta`,
 *  Elixir ms-integers) with no calendar arithmetic and no new dependency.
 *  Calendar-relative offsets (`months`, `years`) are deliberately NOT part
 *  of `duration` — they have no fixed width and would break that uniform
 *  translation; if they return, it is as a distinct calendar/`period` type. */
export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
};
