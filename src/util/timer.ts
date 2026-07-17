/**
 * Timer cadence helpers (scheduling.md, M-T4.1) — shared by the lowering pass
 * (`lower.ts` normalises `every:` to milliseconds) and the IR validator
 * (`loom.timer-cadence` range-checks cron and enforces the `every:`/`cron:`
 * split).  Lives in `ir/util/` so both the `ir/lower` and `ir/validate` layers
 * can consume it without an upward import.
 */

/** Duration unit → milliseconds. */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Cadence floor — the shortest interval a `timerSource` may fire at, to keep
 *  advisory-lock churn sane.  One second (below cron's minute granularity, so
 *  still a legitimate `every:`-only cadence). */
export const MIN_INTERVAL_MS = 1_000;

/** Parse a `DURATION` token (`<int><unit>`, unit ∈ {ms,s,m,h,d}) to milliseconds.
 *  Returns 0 for an unparseable string (the validator reports the real error;
 *  lowering must not throw). */
export function parseDurationMs(literal: string): number {
  const m = /^([0-9]+)(ms|s|m|h|d)$/.exec(literal.trim());
  if (!m) return 0;
  return Number(m[1]) * UNIT_MS[m[2]];
}

/** Cron `@nickname`s every backend's scheduler understands. */
const CRON_NICKNAMES = new Set([
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@hourly",
]);

/** Inclusive numeric bounds for each of the 5 cron fields, in order. */
const CRON_FIELD_BOUNDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

/** Validate a single cron field value (a star, a step, a range, a number, or
 *  comma lists of those) against its numeric bounds.  Returns an error or null. */
function checkCronField(
  raw: string,
  bound: { name: string; min: number; max: number },
): string | null {
  for (const part of raw.split(",")) {
    let body = part;
    if (body.includes("/")) {
      const [range, step] = body.split("/");
      if (!/^[0-9]+$/.test(step)) return `${bound.name} step "/${step}" must be a positive integer`;
      body = range;
    }
    if (body === "*") continue;
    if (body.includes("-")) {
      const [lo, hi] = body.split("-");
      if (!/^[0-9]+$/.test(lo) || !/^[0-9]+$/.test(hi))
        return `${bound.name} range "${part}" is malformed`;
      if (Number(lo) < bound.min || Number(hi) > bound.max) {
        return `${bound.name} must be ${bound.min}-${bound.max}`;
      }
      continue;
    }
    if (!/^[0-9]+$/.test(body))
      return `${bound.name} value "${part}" is not a number, range, or step`;
    if (Number(body) < bound.min || Number(body) > bound.max) {
      return `${bound.name} must be ${bound.min}-${bound.max}`;
    }
  }
  return null;
}

/** Validate a cron expression (a 5-field expression or an `@nickname`).  Returns
 *  an error string (for `loom.timer-cadence`) or null when it is well-formed. */
export function checkCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) {
    return CRON_NICKNAMES.has(trimmed)
      ? null
      : `unknown cron nickname "${trimmed}" (use @yearly/@monthly/@weekly/@daily/@hourly or a 5-field expression)`;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return `must be a 5-field expression (minute hour day-of-month month day-of-week) or an @nickname`;
  }
  for (let i = 0; i < 5; i++) {
    const err = checkCronField(fields[i], CRON_FIELD_BOUNDS[i]);
    if (err) return err;
  }
  return null;
}

/** If a fixed interval is cleanly expressible as a portable 5-field cron
 *  expression, return that cron (so the validator can steer `every:` → `cron:`);
 *  otherwise null.  Cron-expressible = a whole number of minutes/hours that
 *  evenly divides its unit (every N minutes with 60 % N == 0, every N hours with
 *  24 % N == 0), plus the exact daily boundary.  Sub-minute and non-dividing
 *  intervals (7m, 90m, 15s) are NOT cron-expressible — the whole point of
 *  `every:`. */
export function cronEquivalentOf(everyMs: number): string | null {
  if (everyMs <= 0 || everyMs % 60_000 !== 0) return null; // sub-minute → every: only
  const minutes = everyMs / 60_000;
  if (minutes < 60) return 60 % minutes === 0 ? `*/${minutes} * * * *` : null;
  if (minutes % 60 !== 0) return null; // non-dividing (e.g. 90m) → every: only
  const hours = minutes / 60;
  if (hours < 24) return 24 % hours === 0 ? `0 */${hours} * * *` : null;
  if (hours === 24) return `0 0 * * *`;
  return null;
}
