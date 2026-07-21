// Timer scheduler emission (scheduling.md) — the Java/Spring backend, Phase 2.
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  The two
// cadences split by where durability matters:
//
//   • `cron:` timers run on **JobRunr** (Postgres-backed durable jobs).  JobRunr
//     coordinates single-fire across replicas through its store, retries a failed
//     job with backoff, and replays an overdue recurring job on server start
//     (native missed-run).  It takes a standard 5-field Unix cron verbatim (only
//     `@nickname`s are expanded).  JobRunr has no Spring-Boot-4 starter yet, so we
//     wire its **core** ourselves (`JobRunrConfig`): the SQL storage provider
//     (schema auto-created), the background server, and a Spring job activator —
//     the documented "without-starter" path, version-independent.
//
//   • `every:` (sub-minute) timers stay **in-process** (`@Scheduled(fixedRate)`
//     in `TimerScheduler.java` + a transaction-scoped `pg_try_advisory_xact_lock`).
//     Durability is meaningless for a high-frequency poll and JobRunr cron is
//     minute-granular.
//
// Every tick builds its event struct and publishes it through Spring's
// `ApplicationEventPublisher` — the SAME in-process channel the `<Ctx>Dispatcher`
// saga `@EventListener`s subscribe to, so an `on(t)` / `create(t) by …` reactor
// fires with no new dispatch machinery.  Emitted ONLY when the deployable owns a
// timerSource of the matching cadence; unused paths are byte-identical.

import type { EventIR, FieldIR, TimerSourceIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../../util/naming.js";
import { mainSourcePath } from "../naming.js";
import { collectJavaTypeImports } from "../render-expr.js";

/** The `cron:` timers of a set — run on JobRunr. */
export function cronTimers(timers: readonly TimerSourceIR[]): TimerSourceIR[] {
  return timers.filter((ts) => ts.cadence.kind === "cron");
}

/** The `every:` timers of a set — run in-process (@Scheduled + advisory lock). */
export function everyTimers(timers: readonly TimerSourceIR[]): TimerSourceIR[] {
  return timers.filter((ts) => ts.cadence.kind === "every");
}

/** Whether any owned timer uses a real cron expression.  Gates the JobRunr
 *  dependency + the `JobRunrConfig` / `<Pascal>TimerJob` emission. */
export function anyTimerUsesCron(timers: readonly TimerSourceIR[]): boolean {
  return timers.some((ts) => ts.cadence.kind === "cron");
}

/** JobRunr's Cron parser takes a standard 5-field Unix expression verbatim.  It
 *  does not understand the `@nickname` macros Loom allows, so expand those; a
 *  plain 5-field expression passes through unchanged. */
function toJobRunrCron(cron: string): string {
  const t = cron.trim();
  const NICK: Record<string, string> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@hourly": "0 * * * *",
  };
  return t.startsWith("@") ? (NICK[t] ?? "0 * * * *") : t;
}

/** The value expression a scheduler tick uses to fill one tick-event field. */
function tickFieldValue(field: FieldIR): string {
  const t = field.type;
  if (t.kind === "id") return `${t.targetName}Id.newId()`;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "datetime":
        return "Instant.now()";
      case "int":
        return "0";
      case "long":
        return "0L";
      case "decimal":
      case "money":
        return "BigDecimal.ZERO";
      case "bool":
        return "false";
      case "string":
        return '""';
      case "guid":
        return "UUID.randomUUID()";
      case "duration":
        return "Duration.ZERO";
      default:
        return "null";
    }
  }
  return "null";
}

/** `new <Event>(<synth args…>)`, args in the record's declaration order. */
function tickConstruct(event: EventIR): string {
  return `new ${event.name}(${event.fields.map(tickFieldValue).join(", ")})`;
}

/** The tick-value imports (Instant / BigDecimal / UUID / Duration / JsonNode)
 *  over a set of timers' events. */
function tickTypeImports(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
): string[] {
  const set = new Set<string>();
  for (const ts of timers) {
    for (const f of eventByName.get(ts.event)?.fields ?? []) {
      collectJavaTypeImports(f.type, set);
    }
  }
  return [...set].sort();
}

/**
 * Render `TimerScheduler.java` for the `every:` timers — one `@Scheduled(fixedRate)`
 * method each, single-fired by a transaction-scoped advisory lock.  Returns "" when
 * there are no `every:` timers (the file is not emitted).
 */
export function renderJavaTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  basePkg: string,
): string {
  const everys = everyTimers(timers);
  if (everys.length === 0) return "";
  const typeImports = tickTypeImports(everys, eventByName);

  const fields = everys.map(
    (ts) =>
      `    private final AtomicBoolean ${lowerFirst(ts.name)}Running = new AtomicBoolean(false);`,
  );
  const methods = everys.flatMap((ts) => {
    const event = eventByName.get(ts.event);
    const construct = event ? tickConstruct(event) : `new ${ts.event}()`;
    const everyMs = ts.cadence.kind === "every" ? ts.cadence.everyMs : 0;
    return [
      `    // timerSource ${ts.name} { for: ${ts.event}, every: ${everyMs}ms }`,
      `    @Scheduled(fixedRate = ${everyMs})`,
      `    public void ${lowerFirst(ts.name)}() {`,
      `        tick(${JSON.stringify(ts.name)}, ${lowerFirst(ts.name)}Running, () -> ${construct});`,
      `    }`,
      ``,
    ];
  });

  return lines(
    `package ${basePkg};`,
    ``,
    `import java.util.concurrent.atomic.AtomicBoolean;`,
    `import java.util.function.Supplier;`,
    ...typeImports.map((i) => `import ${i};`),
    ``,
    `import org.springframework.context.ApplicationEventPublisher;`,
    `import org.springframework.jdbc.core.JdbcTemplate;`,
    `import org.springframework.scheduling.annotation.EnableScheduling;`,
    `import org.springframework.scheduling.annotation.Scheduled;`,
    `import org.springframework.stereotype.Component;`,
    `import org.springframework.transaction.PlatformTransactionManager;`,
    `import org.springframework.transaction.support.TransactionTemplate;`,
    ``,
    `import ${basePkg}.config.CatalogLog;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    ``,
    `/** In-process wall-clock event sources (scheduling.md) — the sub-minute`,
    ` *  \`every:\` timers.  Each @Scheduled method fires a plain domain event on its`,
    ` *  cadence, single-fired across replicas by a transaction-scoped Postgres`,
    ` *  advisory lock, dispatched through the same ApplicationEventPublisher the`,
    ` *  saga @EventListeners subscribe to.  (\`cron:\` timers run on JobRunr — see`,
    ` *  JobRunrConfig.) */`,
    `@Component`,
    `@EnableScheduling`,
    `public class TimerScheduler {`,
    `    private final ApplicationEventPublisher events;`,
    `    private final TransactionTemplate tx;`,
    `    private final JdbcTemplate jdbc;`,
    ...fields,
    ``,
    `    public TimerScheduler(`,
    `        ApplicationEventPublisher events,`,
    `        PlatformTransactionManager txManager,`,
    `        JdbcTemplate jdbc`,
    `    ) {`,
    `        this.events = events;`,
    `        this.tx = new TransactionTemplate(txManager);`,
    `        this.jdbc = jdbc;`,
    `    }`,
    ``,
    `    // Stable per-timer advisory-lock key — an FNV-1a hash of the timerSource`,
    `    // name into a signed 32-bit int, so two replicas contend on the SAME key.`,
    `    static int timerLockKey(String name) {`,
    `        int h = 0x811c9dc5;`,
    `        for (int i = 0; i < name.length(); i++) {`,
    `            h ^= name.charAt(i);`,
    `            h *= 0x01000193;`,
    `        }`,
    `        return h;`,
    `    }`,
    ``,
    `    // One tick: a TRANSACTION-SCOPED advisory lock (single-fire across`,
    `    // replicas) held on the TransactionTemplate's pinned connection and`,
    `    // released automatically on commit.  The synchronous @EventListener`,
    `    // dispatch joins this tx; a peer replica's concurrent tick fails the try`,
    `    // and skips.  The in-process guard skips an overlapping tick on THIS replica.`,
    `    private void tick(String name, AtomicBoolean running, Supplier<Object> build) {`,
    `        if (!running.compareAndSet(false, true)) {`,
    `            CatalogLog.event("timer_skipped_overlap", "info", "timer", name);`,
    `            return;`,
    `        }`,
    `        try {`,
    `            int lockKey = timerLockKey(name);`,
    `            tx.executeWithoutResult(status -> {`,
    `                Boolean locked = jdbc.queryForObject(`,
    `                    "SELECT pg_try_advisory_xact_lock(?)", Boolean.class, lockKey);`,
    `                if (locked == null || !locked) {`,
    `                    CatalogLog.event("timer_lock_contended", "debug", "timer", name);`,
    `                    return;`,
    `                }`,
    `                events.publishEvent(build.get());`,
    `                CatalogLog.event("timer_fired", "info", "timer", name);`,
    `            });`,
    `        } catch (Exception err) {`,
    `            CatalogLog.event(`,
    `                "timer_emit_failed", "error", "timer", name, "error", String.valueOf(err.getMessage()));`,
    `        } finally {`,
    `            running.set(false);`,
    `        }`,
    `    }`,
    ``,
    ...methods,
    `}`,
    ``,
  );
}

/** The JobRunr job-bean class name for a cron timer. */
function timerJobClass(ts: TimerSourceIR): string {
  return `${upperFirst(ts.name)}TimerJob`;
}

/**
 * Render one `<Pascal>TimerJob.java` — a JobRunr job bean for a `cron:` timer.
 * JobRunr owns single-fire (store-coordinated) + retry + missed-run replay, so
 * the body just builds the tick and publishes it; on failure it rethrows so
 * JobRunr's automatic retry engages.
 */
export function renderJavaTimerJob(
  ts: TimerSourceIR,
  eventByName: Map<string, EventIR>,
  basePkg: string,
): string {
  const cls = timerJobClass(ts);
  const event = eventByName.get(ts.event);
  const construct = event ? tickConstruct(event) : `new ${ts.event}()`;
  const typeImports = tickTypeImports([ts], eventByName);
  return lines(
    `package ${basePkg};`,
    ``,
    ...typeImports.map((i) => `import ${i};`),
    ``,
    `import org.springframework.context.ApplicationEventPublisher;`,
    `import org.springframework.stereotype.Component;`,
    ``,
    `import ${basePkg}.config.CatalogLog;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    ``,
    // A `//` line comment (not a JavaDoc block) — the cron may contain `*/`,
    // which would close a block comment early.
    `// timerSource ${ts.name} { for: ${ts.event}, cron: ${
      ts.cadence.kind === "cron" ? ts.cadence.cron : ""
    } }`,
    `/** A durable JobRunr recurring job for the timerSource above.  Single-fire +`,
    ` *  retry + missed-run replay owned by JobRunr; publishes the tick through the`,
    ` *  same ApplicationEventPublisher the saga @EventListeners subscribe to. */`,
    `@Component`,
    `public class ${cls} {`,
    `    private final ApplicationEventPublisher events;`,
    ``,
    `    public ${cls}(ApplicationEventPublisher events) {`,
    `        this.events = events;`,
    `    }`,
    ``,
    `    public void execute() {`,
    `        try {`,
    `            events.publishEvent(${construct});`,
    `            CatalogLog.event("timer_fired", "info", "timer", ${JSON.stringify(ts.name)});`,
    `        } catch (RuntimeException err) {`,
    `            CatalogLog.event(`,
    `                "timer_emit_failed", "error", "timer", ${JSON.stringify(ts.name)},`,
    `                "error", String.valueOf(err.getMessage()));`,
    `            throw err; // let JobRunr's automatic retry engage`,
    `        }`,
    `    }`,
    `}`,
    ``,
  );
}

/**
 * Render `JobRunrConfig.java` — JobRunr core wired manually (no Spring-Boot
 * starter, which lacks Spring-Boot-4 support): the SQL storage provider (schema
 * auto-created), the background server, a Spring job activator, and one recurring
 * job per `cron:` timer.  Emitted only when the deployable owns a cron timer.
 */
export function renderJobRunrConfig(timers: readonly TimerSourceIR[], basePkg: string): string {
  const crons = cronTimers(timers);
  const recurring = crons.map((ts) => {
    const cls = timerJobClass(ts);
    const cron = toJobRunrCron((ts.cadence as { cron: string }).cron);
    // JobRunr recurring-job ids must be alphanumeric (no `:` / punctuation).
    return `        scheduler.<${cls}>scheduleRecurrently(${JSON.stringify(
      `timer${upperFirst(ts.name)}`,
    )}, ${JSON.stringify(cron)}, ${cls}::execute);`;
  });

  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import javax.sql.DataSource;`,
    ``,
    `import org.jobrunr.configuration.JobRunr;`,
    `import org.jobrunr.jobs.mappers.JobMapper;`,
    `import org.jobrunr.scheduling.JobScheduler;`,
    `import org.jobrunr.storage.StorageProvider;`,
    `import org.jobrunr.storage.sql.common.SqlStorageProviderFactory;`,
    `import org.jobrunr.utils.mapper.jackson.JacksonJsonMapper;`,
    `import org.springframework.context.ApplicationContext;`,
    `import org.springframework.context.annotation.Bean;`,
    `import org.springframework.context.annotation.Configuration;`,
    ``,
    `import ${basePkg}.*;`,
    ``,
    `/** Durable cron timerSources (scheduling.md Phase 2) on JobRunr core.`,
    ` *`,
    ` *  JobRunr has no Spring-Boot-4 starter yet, so we wire its core directly`,
    ` *  (the documented "without Spring Boot starter" path): a SQL StorageProvider`,
    ` *  over the app DataSource (JobRunr creates its own \`jobrunr_*\` tables on`,
    ` *  first use), the background job server, and a Spring job activator so the`,
    ` *  recurring jobs resolve as beans.  Version-independent — no reliance on the`,
    ` *  starter's autoconfiguration. */`,
    `@Configuration`,
    `public class JobRunrConfig {`,
    ``,
    `    @Bean(destroyMethod = "close")`,
    `    public StorageProvider storageProvider(DataSource dataSource) {`,
    `        StorageProvider provider = SqlStorageProviderFactory.using(dataSource);`,
    `        provider.setJobMapper(new JobMapper(new JacksonJsonMapper()));`,
    `        return provider;`,
    `    }`,
    ``,
    `    @Bean`,
    `    public JobScheduler jobScheduler(StorageProvider storageProvider, ApplicationContext ctx) {`,
    `        JobScheduler scheduler = JobRunr.configure()`,
    `            .useJobActivator(ctx::getBean)`,
    `            .useStorageProvider(storageProvider)`,
    `            .useBackgroundJobServer()`,
    `            .initialize()`,
    `            .getJobScheduler();`,
    ...recurring,
    `        return scheduler;`,
    `    }`,
    `}`,
    ``,
  );
}

/** The base-package source path for `TimerScheduler.java`. */
export function javaTimerSchedulerPath(basePkg: string): string {
  return mainSourcePath(basePkg, "TimerScheduler.java");
}

/** The base-package source path for a `<Pascal>TimerJob.java`. */
export function javaTimerJobPath(basePkg: string, ts: TimerSourceIR): string {
  return mainSourcePath(basePkg, `${timerJobClass(ts)}.java`);
}

/** The `config`-package source path for `JobRunrConfig.java`. */
export function jobRunrConfigPath(basePkg: string): string {
  return mainSourcePath(`${basePkg}.config`, "JobRunrConfig.java");
}
