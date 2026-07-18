// Timer scheduler emission (scheduling.md, M-T4.1) — the Hono half of Phase 1.
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  This
// builder renders `scheduler.ts`: one job per owned timer that, on each tick,
// takes a Postgres advisory lock (single-fire across replicas), constructs the
// tick event struct, and dispatches it through the SAME in-process dispatcher
// the sagas already route through — so an `on(t: Tick)` / `create(t: Tick) by …`
// reactor fires with no new dispatch machinery.  Structure (the `running`
// no-overlap guard + array-of-stops disposer) mirrors `startOutboxRelay`.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical to before.

import type { EventIR, FieldIR, TimerSourceIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

/** The value expression a scheduler tick uses to fill one tick-event field.  A
 *  tick is infrastructure-emitted, so every field is synthesised: `at`-style
 *  datetimes get the fire time, id fields get a fresh id (a new saga instance
 *  per tick — the `create(t) by t.<id>` semantics), and any other scalar gets a
 *  type-safe zero. */
function tickFieldValue(field: FieldIR): string {
  const t = field.type;
  if (t.kind === "id") return `Ids.new${t.targetName}Id()`;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return "new Date()";
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "bool":
        return "false";
      case "string":
      case "guid":
        return '""';
      default:
        // money / json / duration: not a meaningful tick field — a type-safe
        // placeholder keeps the emitted struct tsc-clean (ticks carry at/id).
        return "undefined as never";
    }
  }
  return "undefined as never";
}

/** The object literal that constructs one tick event: the `type` discriminator
 *  plus every declared field, synthesised. */
function tickStruct(event: EventIR): string {
  const parts = [
    `type: "${event.name}"`,
    ...event.fields.map((f) => `${f.name}: ${tickFieldValue(f)}`),
  ];
  return `{ ${parts.join(", ")} }`;
}

/** Does any field of any owned timer's event reference an id type?  Gates the
 *  `import * as Ids` (kept out of a timer whose ticks carry no id). */
function anyTickUsesId(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
): boolean {
  return timers.some((ts) =>
    (eventByName.get(ts.event)?.fields ?? []).some((f) => f.type.kind === "id"),
  );
}

/** Whether any owned timer uses a real cron expression (vs a bare-interval
 *  `every:`).  Gates the `node-cron` import + dependency. */
export function anyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/**
 * Render `scheduler.ts` for a deployable's owned timers.  `eventByName` resolves
 * each timer's `for:` event to its declared field shape (for the tick struct).
 */
export function renderTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
): string {
  const usesCron = anyTimerUsesCron(timers);
  const usesIds = anyTickUsesId(timers, eventByName);

  const jobs = timers.map((ts) => {
    const event = eventByName.get(ts.event);
    const struct = event ? tickStruct(event) : `{ type: "${ts.event}" }`;
    const build = `() => (${struct})`;
    const schedule =
      ts.cadence.kind === "cron"
        ? [
            `    const task = cron.schedule(${JSON.stringify(ts.cadence.cron)}, () => void tick());`,
            `    stops.push(() => task.stop());`,
          ]
        : [
            `    const handle = setInterval(() => void tick(), ${ts.cadence.everyMs});`,
            `    stops.push(() => clearInterval(handle));`,
          ];
    return lines(
      `  // timerSource ${ts.name} { for: ${ts.event}, ${
        ts.cadence.kind === "cron"
          ? `cron: ${JSON.stringify(ts.cadence.cron)}`
          : `every: ${ts.cadence.everyMs}ms`
      } }`,
      `  {`,
      `    const tick = makeTick(${JSON.stringify(ts.name)}, ${build});`,
      ...schedule,
      `  }`,
    );
  });

  return lines(
    "// Auto-generated — emitted only when this deployable owns timerSources (scheduling.md).",
    `import { sql } from "drizzle-orm";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    usesCron ? `import cron from "node-cron";` : false,
    usesIds ? `import * as Ids from "./domain/ids";` : false,
    `import type * as Events from "./domain/events";`,
    `import type { DomainEventDispatcher } from "./domain/events";`,
    `import type * as schema from "./db/schema";`,
    `import { baseLogger } from "./obs/log";`,
    "",
    "// Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource name",
    "// into a signed 32-bit int, so two replicas contend on the SAME key.",
    "// pg_try_advisory_xact_lock is non-blocking: the loser skips this tick.",
    "function timerLockKey(name: string): number {",
    "  let h = 0x811c9dc5;",
    "  for (let i = 0; i < name.length; i++) {",
    "    h ^= name.charCodeAt(i);",
    "    h = Math.imul(h, 0x01000193);",
    "  }",
    "  return h | 0;",
    "}",
    "",
    "export function startTimerScheduler(",
    "  db: NodePgDatabase<typeof schema>,",
    "  events: DomainEventDispatcher,",
    "): () => void {",
    "  const stops: Array<() => void> = [];",
    "",
    "  // One tick: a TRANSACTION-SCOPED advisory lock (single-fire across replicas)",
    "  // -> build the event -> dispatch.  pg_try_advisory_xact_lock is held on the",
    "  // transaction's single pinned connection and released automatically when the",
    "  // tx commits — so there is no manual unlock to leak onto a different pooled",
    "  // connection (a plain session-level pg_advisory_lock + pool would).  The",
    "  // dispatch runs inside the tx window, so a peer replica's concurrent tick",
    "  // fails the try and skips; the lock is a mutex, not the reactor's own",
    "  // transaction.  The in-process `running` guard skips (does not queue) a tick",
    "  // that overlaps a slow body on THIS replica.",
    "  const makeTick = (name: string, build: () => Events.DomainEvent) => {",
    "    const lockKey = timerLockKey(name);",
    "    let running = false;",
    "    return async (): Promise<void> => {",
    "      if (running) {",
    '        baseLogger.info({ event: "timer_skipped_overlap", timer: name });',
    "        return;",
    "      }",
    "      running = true;",
    "      try {",
    "        await db.transaction(async (tx) => {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source — `${lockKey}` is a template literal in the generated code, not this file's.
    "          const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`);",
    "          const locked = (lock.rows[0] as { locked: boolean } | undefined)?.locked ?? false;",
    "          if (!locked) {",
    '            baseLogger.debug({ event: "timer_lock_contended", timer: name });',
    "            return;",
    "          }",
    "          await events.dispatch(build());",
    '          baseLogger.info({ event: "timer_fired", timer: name });',
    "        });",
    "      } catch (err) {",
    "        baseLogger.error({",
    '          event: "timer_emit_failed",',
    "          timer: name,",
    "          error: err instanceof Error ? err.message : String(err),",
    "        });",
    "      } finally {",
    "        running = false;",
    "      }",
    "    };",
    "  };",
    "",
    ...jobs,
    "",
    "  return () => {",
    "    for (const stop of stops) stop();",
    "  };",
    "}",
  );
}
