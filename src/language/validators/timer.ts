// TimerSource cadence validation (scheduling.md, M-T4.1).
//
// The cadence checks live at the AST level because they need BOTH raw grammar
// fields (`cron:` and `every:`) — lowering discriminates the cadence to exactly
// one, so "both set" is invisible by the IR phase.  The references resolve at
// parse time, so these land on a fresh `.ddd` edit.
//
//   - `loom.timer-cadence` — exactly one of `cron:` / `every:` must be set; a
//     `cron:` must be a valid 5-field expression or an `@nickname`; an `every:`
//     must be at or above the floor and NOT cleanly cron-expressible (the escape
//     hatch is only for what cron can't say).
//
// The other timer gates (infra-emitted event shape, single-fire state
// requirement, dead-config unbound warning) are cross-cutting semantics and live
// in the IR validator (`src/ir/validate/checks/timer-checks.ts`).

import { AstUtils, type ValidationAcceptor } from "langium";
import { checkCron, cronEquivalentOf, MIN_INTERVAL_MS, parseDurationMs } from "../../util/timer.js";
import { isTimerSource, type Model } from "../generated/ast.js";

export function checkTimers(model: Model, accept: ValidationAcceptor): void {
  for (const ts of [...AstUtils.streamAllContents(model)].filter(isTimerSource)) {
    const hasCron = ts.cron != null;
    const hasEvery = ts.every != null;

    if (hasCron && hasEvery) {
      accept(
        "error",
        `timerSource '${ts.name}' sets both 'cron:' and 'every:' — set exactly one.`,
        { node: ts, property: "every", code: "loom.timer-cadence" },
      );
      continue;
    }
    if (!hasCron && !hasEvery) {
      accept(
        "error",
        `timerSource '${ts.name}' sets neither 'cron:' nor 'every:' — a cadence is required.`,
        { node: ts, property: "name", code: "loom.timer-cadence" },
      );
      continue;
    }

    if (hasCron) {
      const err = checkCron(ts.cron ?? "");
      if (err) {
        accept("error", `cron on timerSource '${ts.name}' is invalid: ${err}.`, {
          node: ts,
          property: "cron",
          code: "loom.timer-cadence",
        });
      }
      continue;
    }

    // every: — must be parseable, at/above the floor, and not cron-expressible.
    const ms = parseDurationMs(ts.every ?? "");
    if (ms <= 0) {
      accept(
        "error",
        `'every:' on timerSource '${ts.name}' is not a valid duration (e.g. 15s, 90m).`,
        {
          node: ts,
          property: "every",
          code: "loom.timer-cadence",
        },
      );
      continue;
    }
    if (ms < MIN_INTERVAL_MS) {
      accept(
        "error",
        `'every:' on timerSource '${ts.name}' is below the ${MIN_INTERVAL_MS}ms floor — timers may not fire more often than once per second.`,
        { node: ts, property: "every", code: "loom.timer-cadence" },
      );
      continue;
    }
    const cronEquiv = cronEquivalentOf(ms);
    if (cronEquiv) {
      accept(
        "error",
        `'every:' on timerSource '${ts.name}' is cleanly cron-expressible — write 'cron: "${cronEquiv}"'. 'every:' is only for intervals cron cannot express (sub-minute, or non-dividing like 7m/90m).`,
        { node: ts, property: "every", code: "loom.timer-cadence" },
      );
    }
  }
}
