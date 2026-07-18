// Timer scheduler emission (scheduling.md, M-T4.1) — the Java/Spring half.
//
// A `timerSource` fires a plain domain event on a wall-clock cadence.  This
// renders `TimerScheduler.java`: a `@Component` (carrying `@EnableScheduling`,
// so the no-timer project stays byte-identical — nothing else in the tree
// changes) with one `@Scheduled` method per owned timer.  Each tick takes a
// Postgres advisory lock (single-fire across replicas), builds the tick event
// struct, and publishes it through Spring's ApplicationEventPublisher — the
// SAME in-process channel the `<Ctx>Dispatcher` saga handlers subscribe to via
// `@EventListener`, so an `on(t: Tick)` / `create(t: Tick) by …` reactor fires
// with no new dispatch machinery.
//
// Single-fire is a TRANSACTION-SCOPED advisory lock (`pg_try_advisory_xact_lock`
// on the TransactionTemplate's pinned connection, released automatically when
// the tx commits) — NOT a session-level lock+unlock, which would leak the
// unlock onto a different pooled connection.  The synchronous @EventListener
// dispatch (the dispatcher is `@Transactional`, so it joins this tx) runs inside
// the lock window, so a peer replica's concurrent tick fails the try and skips.
// A per-timer in-process guard skips (does not queue) a tick that overlaps a
// slow body on THIS replica.
//
// Emitted ONLY when the deployable owns at least one timerSource; a timer-free
// deployable is byte-identical to before (no TimerScheduler.java, no
// @EnableScheduling, no new dep — spring-context / spring-tx / spring-jdbc are
// already on the classpath).

import type { EventIR, FieldIR, TimerSourceIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { mainSourcePath } from "../naming.js";
import { collectJavaTypeImports } from "../render-expr.js";

/** The value expression a scheduler tick uses to fill one tick-event field.  A
 *  tick is infrastructure-emitted, so every field is synthesised: `at`-style
 *  datetimes get the fire time, id fields get a fresh id (a new saga instance
 *  per tick — the `create(t) by t.<id>` semantics), and any other scalar gets a
 *  type-safe zero. */
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
        // json: not a meaningful tick field — a null JsonNode keeps the emitted
        // record construction compiling (ticks carry at/id).
        return "null";
    }
  }
  return "null";
}

/** The positional constructor for one tick event: `new <Event>(<synth args…>)`,
 *  args in the record's declaration order (the same order `renderJavaEvent`
 *  emits the record components, so construction can't drift). */
function tickConstruct(event: EventIR): string {
  return `new ${event.name}(${event.fields.map(tickFieldValue).join(", ")})`;
}

/** Convert Loom's 5-field cron (or an `@nickname`) to Spring's 6-field form.
 *  Spring's `@Scheduled(cron = …)` prepends a seconds field; a bare 5-field
 *  expression fires at second 0.  Spring supports the `@yearly`/`@monthly`/…
 *  macros natively, so pass those through unchanged. */
function toSpringCron(cron: string): string {
  const t = cron.trim();
  return t.startsWith("@") ? t : `0 ${t}`;
}

/**
 * Render `TimerScheduler.java` for a deployable's owned timers.  `eventByName`
 * resolves each timer's `for:` event to its declared field shape (for the tick
 * construction); `basePkg` is the deployable's root package.  Emitted at the
 * base package (alongside Application.java), so it component-scans automatically.
 */
export function renderJavaTimerScheduler(
  timers: readonly TimerSourceIR[],
  eventByName: Map<string, EventIR>,
  basePkg: string,
): string {
  // Imports the synthesised tick values need (Instant / BigDecimal / UUID /
  // Duration / JsonNode), derived over every owned timer's event fields — the
  // same per-type set the event record itself imports.  Id values ride the
  // `domain.ids.*` wildcard.
  const typeImports = new Set<string>();
  for (const ts of timers) {
    for (const f of eventByName.get(ts.event)?.fields ?? []) {
      collectJavaTypeImports(f.type, typeImports);
    }
  }

  // Per-timer overlap-guard fields + @Scheduled methods.
  const fields = timers.map(
    (ts) =>
      `    private final AtomicBoolean ${lowerFirst(ts.name)}Running = new AtomicBoolean(false);`,
  );
  const methods = timers.flatMap((ts) => {
    const event = eventByName.get(ts.event);
    const construct = event ? tickConstruct(event) : `new ${ts.event}()`;
    const scheduleArg =
      ts.cadence.kind === "cron"
        ? `cron = ${JSON.stringify(toSpringCron(ts.cadence.cron))}`
        : `fixedRate = ${ts.cadence.everyMs}`;
    return [
      `    // timerSource ${ts.name} { for: ${ts.event}, ${
        ts.cadence.kind === "cron"
          ? `cron: ${JSON.stringify(ts.cadence.cron)}`
          : `every: ${ts.cadence.everyMs}ms`
      } }`,
      `    @Scheduled(${scheduleArg})`,
      `    public void ${lowerFirst(ts.name)}() {`,
      `        tick(${JSON.stringify(ts.name)}, ${lowerFirst(ts.name)}Running, () -> ${construct});`,
      `    }`,
      ``,
    ];
  });

  return lines(
    // Auto-generated — emitted only when this deployable owns timerSources
    // (scheduling.md).
    `package ${basePkg};`,
    ``,
    `import java.util.concurrent.atomic.AtomicBoolean;`,
    `import java.util.function.Supplier;`,
    ...[...typeImports].sort().map((i) => `import ${i};`),
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
    `/** Wall-clock event sources (scheduling.md).  Each @Scheduled method fires a`,
    ` *  plain domain event on its cadence, single-fired across replicas by a`,
    ` *  transaction-scoped Postgres advisory lock, dispatched through the same`,
    ` *  in-process ApplicationEventPublisher the saga @EventListeners subscribe to. */`,
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
    `    // name into a signed 32-bit int, so two replicas contend on the SAME key`,
    `    // (the same derivation the Hono scheduler uses).`,
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
    `    // replicas) -> build the event -> publish.  pg_try_advisory_xact_lock is`,
    `    // held on the TransactionTemplate's pinned connection and released`,
    `    // automatically on commit — so there is no manual unlock to leak onto a`,
    `    // different pooled connection.  The synchronous @EventListener dispatch`,
    `    // joins this tx (the dispatcher is @Transactional), so it runs inside the`,
    `    // lock window; a peer replica's concurrent tick fails the try and skips.`,
    `    // The in-process guard skips (does not queue) a tick that overlaps a slow`,
    `    // body on THIS replica.`,
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

/** The base-package source path for `TimerScheduler.java` (alongside
 *  Application.java), so the index orchestrator places it without a new
 *  layout category. */
export function javaTimerSchedulerPath(basePkg: string): string {
  return mainSourcePath(basePkg, "TimerScheduler.java");
}
