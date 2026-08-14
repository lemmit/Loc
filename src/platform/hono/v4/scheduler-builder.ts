// Timer scheduler emission (scheduling.md) — the Hono backend, Phase 2 (durable).
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  This
// builder renders `scheduler.ts`, splitting the owned timers by cadence:
//
//   • `cron:` timers run on **pg-boss** — a Postgres-backed durable job queue.
//     pg-boss owns single-fire across replicas (native, no advisory lock),
//     persists each run, and retries a failed body with backoff.  pg-boss does
//     NOT back-fill a cron window missed while every replica was down (its
//     `shouldSendIt` gate only sends when the last boundary is < 60s old), so a
//     tiny `loom_timer_runs` watermark drives a **coalesce-once catch-up** on
//     boot: if the previous boundary is > 60s old and later than the last
//     recorded fire, we replay it exactly once.
//
//   • `every:` (sub-minute) timers stay **in-process** (`setInterval` + a
//     transaction-scoped `pg_try_advisory_xact_lock` for single-fire).
//     Durability is meaningless for a high-frequency poll — resume-at-next-tick
//     is the correct behaviour — and pg-boss cron is minute-granularity.
//
// Every tick constructs its event struct and dispatches it through the SAME
// in-process dispatcher the sagas route through, so an `on(t)` / `create(t) by`
// reactor fires with no new machinery.  Emitted ONLY when the deployable owns at
// least one timerSource; a timer-free deployable is byte-identical to before.

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

/** Split a deployable's owned timers by cadence — cron (→ pg-boss, durable) vs
 *  interval (→ in-process). */
function partitionByCadence(timers: readonly TimerSourceIR[]): {
  cron: TimerSourceIR[];
  interval: TimerSourceIR[];
} {
  const cron: TimerSourceIR[] = [];
  const interval: TimerSourceIR[] = [];
  for (const ts of timers) {
    (ts.cadence.kind === "cron" ? cron : interval).push(ts);
  }
  return { cron, interval };
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

/** Whether any owned timer uses a real cron expression.  Gates the durable
 *  `pg-boss` + `cron-parser` dependencies (a deployable with only `every:`
 *  timers needs neither). */
export function anyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** The raw-SQL seam between the two node persistence adapters (M-T6.23 slice 3).
 *
 *  `scheduler.ts` is the one emitted module whose database access is NOT domain
 *  persistence: a self-owned `loom_timer_runs` watermark table and a
 *  transaction-scoped advisory lock, both plain SQL.  Drizzle spells that
 *  `db.execute(sql`…`)` returning `{ rows }`; MikroORM spells it
 *  `em.getConnection().execute(sql, params)` returning the rows directly (the
 *  same idiom `emitMikroSeeds` uses).  Only these five call sites diverge, so
 *  they are a leaf table rather than a duplicated builder. */
interface TimerStore {
  /** The `db` parameter's TypeScript type. */
  readonly dbType: string;
  /** Imports the store needs (adapter-specific). */
  readonly imports: readonly string[];
  /** `CREATE TABLE IF NOT EXISTS loom_timer_runs …`, at `  ` indent. */
  readonly createWatermark: readonly string[];
  /** Upsert the watermark to `now()` for `queue`. */
  upsertWatermark(indent: string, conflict: "update" | "nothing"): readonly string[];
  /** Read the watermark into `const last: Date | undefined` for `queue`. */
  readWatermark(indent: string): readonly string[];
  /** Run `body` inside a transaction whose ambient connection holds the
   *  advisory lock, binding `const locked: boolean`.  The lock is
   *  `pg_try_advisory_xact_lock`, so it MUST share the transaction's connection
   *  — on a fresh connection it would be released immediately and every replica
   *  would fire. */
  lockedTransaction(indent: string, body: readonly string[]): readonly string[];
}

const DRIZZLE_TIMER_STORE: TimerStore = {
  dbType: "NodePgDatabase<typeof schema>",
  imports: [
    `import { sql } from "drizzle-orm";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import type * as schema from "./db/schema";`,
  ],
  createWatermark: [
    "  await db.execute(",
    "    sql`CREATE TABLE IF NOT EXISTS loom_timer_runs (timer text PRIMARY KEY," +
      " last_fired_at timestamptz NOT NULL DEFAULT now())`,",
    "  );",
  ],
  upsertWatermark: (indent, conflict) => [
    `${indent}await db.execute(`,
    `${indent}  sql\`INSERT INTO loom_timer_runs (timer, last_fired_at) VALUES (\${queue}, now())` +
      (conflict === "update"
        ? " ON CONFLICT (timer) DO UPDATE SET last_fired_at = now()`,"
        : " ON CONFLICT (timer) DO NOTHING`,"),
    `${indent});`,
  ],
  readWatermark: (indent) => [
    `${indent}const seen = await db.execute(sql\`SELECT last_fired_at FROM loom_timer_runs WHERE timer = \${queue}\`);`,
    `${indent}// node-postgres returns timestamptz as a string — coerce before compare.`,
    `${indent}const raw = (seen.rows[0] as { last_fired_at: string | Date } | undefined)?.last_fired_at;`,
    `${indent}const last = raw != null ? new Date(raw) : undefined;`,
  ],
  lockedTransaction: (indent, body) => [
    `${indent}await db.transaction(async (tx) => {`,
    `${indent}  const lock = await tx.execute(sql\`SELECT pg_try_advisory_xact_lock(\${lockKey}) AS locked\`);`,
    `${indent}  const locked = (lock.rows[0] as { locked: boolean } | undefined)?.locked ?? false;`,
    ...body,
    `${indent}});`,
  ],
};

const MIKRO_TIMER_STORE: TimerStore = {
  dbType: "EntityManager",
  imports: [`import { EntityManager } from "@mikro-orm/postgresql";`],
  createWatermark: [
    "  await db.getConnection().execute(",
    '    "CREATE TABLE IF NOT EXISTS loom_timer_runs (timer text PRIMARY KEY,' +
      ' last_fired_at timestamptz NOT NULL DEFAULT now())",',
    "  );",
  ],
  upsertWatermark: (indent, conflict) => [
    `${indent}await db.getConnection().execute(`,
    `${indent}  "INSERT INTO loom_timer_runs (timer, last_fired_at) VALUES (?, now())` +
      (conflict === "update"
        ? ' ON CONFLICT (timer) DO UPDATE SET last_fired_at = now()",'
        : ' ON CONFLICT (timer) DO NOTHING",'),
    `${indent}  [queue],`,
    `${indent});`,
  ],
  readWatermark: (indent) => [
    `${indent}const seen = (await db.getConnection().execute(`,
    `${indent}  "SELECT last_fired_at FROM loom_timer_runs WHERE timer = ?",`,
    `${indent}  [queue],`,
    `${indent})) as { last_fired_at: string | Date }[];`,
    `${indent}// the pg driver returns timestamptz as a string — coerce before compare.`,
    `${indent}const raw = seen[0]?.last_fired_at;`,
    `${indent}const last = raw != null ? new Date(raw) : undefined;`,
  ],
  lockedTransaction: (indent, body) => [
    // `em.transactional` opens the transaction; the raw lock query is bound to
    // it explicitly through `getTransactionContext()` — without that context
    // the driver would take a pooled connection, the xact lock would end with
    // that statement, and single-fire across replicas would silently be lost.
    `${indent}await db.transactional(async (tem) => {`,
    `${indent}  const lock = (await tem.getConnection().execute(`,
    `${indent}    "SELECT pg_try_advisory_xact_lock(?) AS locked",`,
    `${indent}    [lockKey],`,
    `${indent}    "all",`,
    `${indent}    tem.getTransactionContext(),`,
    `${indent}  )) as { locked: boolean }[];`,
    `${indent}  const locked = lock[0]?.locked ?? false;`,
    ...body,
    `${indent}});`,
  ],
};

/** The pg-boss durable block for the `cron:` timers (one queue + worker +
 *  schedule + coalesce-once catch-up per timer). */
function cronBlock(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  store: TimerStore,
): string[] {
  const jobs = timers.flatMap((ts) => {
    if (ts.cadence.kind !== "cron") return [];
    const event = eventByName.get(ts.event);
    const struct = event ? tickStruct(event) : `{ type: "${ts.event}" }`;
    const queue = `timer_${ts.name}`;
    const cronLit = JSON.stringify(ts.cadence.cron);
    const nameLit = JSON.stringify(ts.name);
    return [
      lines(
        `  // timerSource ${ts.name} { for: ${ts.event}, cron: ${ts.cadence.cron} } — durable (pg-boss)`,
        `  {`,
        `    const queue = ${JSON.stringify(queue)};`,
        `    await boss.createQueue(queue);`,
        `    await boss.work(queue, async () => {`,
        `      await events.dispatch(${struct});`,
        ...store.upsertWatermark("      ", "update"),
        `      baseLogger.info({ event: "timer_fired", timer: ${nameLit} });`,
        `    });`,
        `    // Durable schedule: single-fire across replicas + retry with backoff.`,
        `    await boss.schedule(queue, ${cronLit}, {}, { retryLimit: 3, retryBackoff: true });`,
        `    // Coalesce-once catch-up: pg-boss does not back-fill a boundary missed`,
        `    // while every replica was down.  On the FIRST boot (no watermark) we`,
        `    // establish a baseline WITHOUT retro-firing — a fresh deploy must not`,
        `    // replay historical boundaries.  On a later boot, if the previous`,
        `    // boundary is > 60s old (outside pg-boss's own send window, so no`,
        `    // double-fire) and later than the last recorded run, replay it once.`,
        `    {`,
        `      const prev = CronExpressionParser.parse(${cronLit}, { currentDate: new Date() }).prev().toDate();`,
        `      const ageSec = (Date.now() - prev.getTime()) / 1000;`,
        ...store.readWatermark("      "),
        `      if (!last) {`,
        ...store.upsertWatermark("        ", "nothing"),
        `      } else if (ageSec >= 60 && last.getTime() < prev.getTime()) {`,
        `        await boss.send(queue, {}, { singletonKey: prev.toISOString() });`,
        `        baseLogger.info({ event: "timer_catchup", timer: ${nameLit}, boundary: prev.toISOString() });`,
        `      }`,
        `    }`,
        `  }`,
      ),
    ];
  });

  return [
    "  // ── cron timers: pg-boss (durable, retried, single-fire across replicas) ──",
    "  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });",
    '  boss.on("error", (err) =>',
    '    baseLogger.error({ event: "timer_emit_failed", timer: "(pg-boss)",',
    "      error: err instanceof Error ? err.message : String(err) }),",
    "  );",
    "  await boss.start();",
    "  // Watermark for the coalesce-once catch-up (pg-boss has no missed-window",
    "  // back-fill).  Self-owned — created here like pg-boss creates its own",
    "  // schema, so it never enters the domain MigrationsIR.",
    ...store.createWatermark,
    "  disposers.push(async () => {",
    "    await boss.stop();",
    "  });",
    "",
    ...jobs,
  ];
}

/** The in-process block for the `every:` timers (setInterval + a
 *  transaction-scoped advisory lock for single-fire). */
function intervalBlock(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  store: TimerStore,
): string[] {
  const jobs = timers.flatMap((ts) => {
    if (ts.cadence.kind !== "every") return [];
    const event = eventByName.get(ts.event);
    const struct = event ? tickStruct(event) : `{ type: "${ts.event}" }`;
    return [
      lines(
        `  // timerSource ${ts.name} { for: ${ts.event}, every: ${ts.cadence.everyMs}ms } — in-process`,
        `  {`,
        `    const tick = makeIntervalTick(${JSON.stringify(ts.name)}, () => (${struct}));`,
        `    const handle = setInterval(() => void tick(), ${ts.cadence.everyMs});`,
        `    disposers.push(() => clearInterval(handle));`,
        `  }`,
      ),
    ];
  });

  return [
    "  // ── every: timers — in-process (setInterval + tx-scoped advisory lock) ──",
    "  const makeIntervalTick = (name: string, build: () => Events.DomainEvent) => {",
    "    const lockKey = timerLockKey(name);",
    "    let running = false;",
    "    return async (): Promise<void> => {",
    "      if (running) {",
    '        baseLogger.info({ event: "timer_skipped_overlap", timer: name });',
    "        return;",
    "      }",
    "      running = true;",
    "      try {",
    ...store.lockedTransaction("        ", [
      "          if (!locked) {",
      '            baseLogger.debug({ event: "timer_lock_contended", timer: name });',
      "            return;",
      "          }",
      "          await events.dispatch(build());",
      '          baseLogger.info({ event: "timer_fired", timer: name });',
    ]),
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
  ];
}

/**
 * Render `scheduler.ts` for a deployable's owned timers.  `eventByName` resolves
 * each timer's `for:` event to its declared field shape (for the tick struct).
 */
export function renderTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  /** `persistence: mikroorm` — run the watermark + advisory lock on the
   *  EntityManager instead of Drizzle (M-T6.23 slice 3).  Default false keeps
   *  the Drizzle output byte-identical. */
  usingMikro = false,
): string {
  const { cron, interval } = partitionByCadence(timers);
  const usesIds = anyTickUsesId(timers, eventByName);
  const store = usingMikro ? MIKRO_TIMER_STORE : DRIZZLE_TIMER_STORE;

  return lines(
    "// Auto-generated — durable timer scheduler (scheduling.md Phase 2).",
    "// cron: → pg-boss (durable, retried, single-fire); every: → in-process.",
    "// Emitted only when this deployable owns timerSources.",
    cron.length > 0 ? `import { PgBoss } from "pg-boss";` : false,
    cron.length > 0 ? `import { CronExpressionParser } from "cron-parser";` : false,
    // The persistence-adapter store's own imports.  Ordered as the drizzle path
    // emitted them (sql, NodePgDatabase, … then `schema` after the domain
    // imports) so the default output is byte-identical; the mikro store has a
    // single import and no `schema` module to reference.
    ...store.imports.filter((i) => !i.includes("./db/schema")),
    usesIds ? `import * as Ids from "./domain/ids";` : false,
    `import type * as Events from "./domain/events";`,
    `import type { DomainEventDispatcher } from "./domain/events";`,
    ...store.imports.filter((i) => i.includes("./db/schema")),
    `import { baseLogger } from "./obs/log";`,
    "",
    interval.length > 0
      ? lines(
          "// Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource",
          "// name into a signed 32-bit int, so two replicas contend on the SAME key.",
          "function timerLockKey(name: string): number {",
          "  let h = 0x811c9dc5;",
          "  for (let i = 0; i < name.length; i++) {",
          "    h ^= name.charCodeAt(i);",
          "    h = Math.imul(h, 0x01000193);",
          "  }",
          "  return h | 0;",
          "}",
          "",
        )
      : false,
    "// Starts every owned timer.  Async: pg-boss boot is async, and the returned",
    "// disposer awaits a clean pg-boss shutdown.",
    "export async function startTimerScheduler(",
    `  db: ${store.dbType},`,
    "  events: DomainEventDispatcher,",
    "): Promise<() => Promise<void>> {",
    "  const disposers: Array<() => void | Promise<void>> = [];",
    "",
    ...(cron.length > 0 ? cronBlock(cron, eventByName, store) : []),
    cron.length > 0 && interval.length > 0 ? "" : false,
    ...(interval.length > 0 ? intervalBlock(interval, eventByName, store) : []),
    "",
    "  return async () => {",
    "    for (const dispose of disposers) await dispose();",
    "  };",
    "}",
  );
}
