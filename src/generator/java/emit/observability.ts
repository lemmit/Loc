import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Observability catalog — JSON event lines on stdout, the cross-backend
// envelope the obs e2e suites assert:
//
//   server_starting → server_listening → request_start {method,path} →
//   request_end {status, durationMs} → server_shutdown → server_drained
//
// Events are logged through SLF4J on a dedicated `loomCatalog` logger;
// `config/logback.xml` (renderLogbackConfig) serialises them to the flat JSON
// envelope via logstash-logback-encoder — so JSON writing, string escaping,
// and MDC enrichment are the logging stack's job, not a hand-rolled writer.
// Mirrors dotnet's AddJsonConsole catalog and Hono's pino lines in event
// vocabulary.
// ---------------------------------------------------------------------------

export function renderCatalogLogger(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import java.util.Map;`,
    ``,
    `import org.slf4j.Logger;`,
    `import org.slf4j.LoggerFactory;`,
    `import org.slf4j.spi.LoggingEventBuilder;`,
    ``,
    `/** Catalog event emitter — one flat JSON object per line on stdout.  Every`,
    ` *  line leads with the cross-backend envelope (\`ts\`, \`level\`, \`event\`),`,
    ` *  then the ambient carrier ids (request_id / scope_id / actor_id) so a log`,
    ` *  line joins to the audit / provenance rows of the same request frame`,
    ` *  (omitted on boot-time lines, where no frame is active).`,
    ` *`,
    ` *  Events log through SLF4J on the \`loomCatalog\` logger; \`logback.xml\` wires`,
    ` *  logstash-logback-encoder to render the JSON — the encoder maps the`,
    ` *  timestamp to \`ts\`, the whitelisted MDC keys to the carrier ids`,
    ` *  (\`correlation_id\` renamed to \`request_id\`), and the SLF4J key/value pairs`,
    ` *  to \`level\` / \`event\` / the per-event fields.  Numbers stay JSON numbers.`,
    ` *`,
    ` *  Emission is gated by the \`LOG_LEVEL\` env var (default \`info\`); a line`,
    ` *  whose level is below the threshold is dropped.  Java has no \`trace\``,
    ` *  level, so a catalog \`trace\` event folds to \`debug\` (both for the`,
    ` *  emitted \`level\` value and for threshold comparison) — matching the`,
    ` *  Hono \`level: process.env.LOG_LEVEL ?? "info"\` channel. */`,
    `public final class CatalogLog {`,
    `    private static final Logger LOG = LoggerFactory.getLogger("loomCatalog");`,
    ``,
    `    private CatalogLog() {`,
    `    }`,
    ``,
    `    // Numeric rank per level — higher = more severe.  trace folds onto debug.`,
    `    private static final Map<String, Integer> RANK = Map.of(`,
    `        "trace", 10, "debug", 10, "info", 20, "warn", 30, "error", 40);`,
    ``,
    `    private static final int THRESHOLD =`,
    `        RANK.getOrDefault(normalize(System.getenv("LOG_LEVEL")), 20);`,
    ``,
    `    /** Fold an incoming/configured level to a known rank key (trace → debug); `,
    `     *  null / unknown → "info". */`,
    `    private static String normalize(String level) {`,
    `        if (level == null) {`,
    `            return "info";`,
    `        }`,
    `        var l = level.toLowerCase();`,
    `        if (l.equals("trace")) {`,
    `            return "debug";`,
    `        }`,
    `        return RANK.containsKey(l) ? l : "info";`,
    `    }`,
    ``,
    `    /** kvs alternate key/value; numbers serialise as raw JSON numbers,`,
    `     *  everything else as JSON strings (escaping handled by the encoder). */`,
    `    public static void event(String name, String level, Object... kvs) {`,
    `        var lvl = normalize(level);`,
    `        if (RANK.get(lvl) < THRESHOLD) {`,
    `            return;`,
    `        }`,
    `        var builder = builderFor(lvl).addKeyValue("level", lvl).addKeyValue("event", name);`,
    `        for (int i = 0; i + 1 < kvs.length; i += 2) {`,
    `            builder = builder.addKeyValue(String.valueOf(kvs[i]), kvs[i + 1]);`,
    `        }`,
    `        builder.log();`,
    `    }`,
    ``,
    `    /** Map the folded catalog level onto the SLF4J level the event logs at.`,
    `     *  The \`loomCatalog\` logger stays open (TRACE) in logback so filtering`,
    `     *  happens once, here, against \`LOG_LEVEL\` — not a second time downstream. */`,
    `    private static LoggingEventBuilder builderFor(String lvl) {`,
    `        return switch (lvl) {`,
    `            case "debug" -> LOG.atDebug();`,
    `            case "warn" -> LOG.atWarn();`,
    `            case "error" -> LOG.atError();`,
    `            default -> LOG.atInfo();`,
    `        };`,
    `    }`,
    `}`,
    ``,
  );
}

// ---------------------------------------------------------------------------
// logback.xml — the logging configuration behind the observability catalog.
//
// Two console channels, both on stdout:
//   • CONSOLE  — human-readable text for the framework/app's own logs (root).
//   • CATALOG  — the structured JSON envelope for catalog events, encoded by
//     logstash-logback-encoder.  Its providers map timestamp → `ts`, the
//     whitelisted MDC keys → the carrier ids (correlation_id renamed to
//     request_id), and the SLF4J key/value pairs → level / event / fields.
//
// A plain `logback.xml` (not `logback-spring.xml`) on purpose: logback loads
// it on first logger use, which happens for `server_starting` in
// Application.main BEFORE SpringApplication.run — a `-spring` variant would not
// be configured yet, so that first catalog line would miss the JSON channel.
// ---------------------------------------------------------------------------

export function renderLogbackConfig(): string {
  return lines(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- Generated by Loom - do not edit by hand. -->`,
    `<configuration>`,
    `    <!-- Human-readable console for the framework/app's own logs. -->`,
    `    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">`,
    `        <encoder>`,
    `            <pattern>%d{yyyy-MM-dd'T'HH:mm:ss.SSSXXX} %-5level %logger{36} - %msg%n</pattern>`,
    `        </encoder>`,
    `    </appender>`,
    ``,
    `    <!-- Structured catalog channel: the cross-backend JSON envelope on`,
    `         stdout.  logstash-logback-encoder does the JSON writing/escaping the`,
    `         app used to hand-roll. -->`,
    `    <appender name="CATALOG" class="ch.qos.logback.core.ConsoleAppender">`,
    `        <encoder class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder">`,
    `            <providers>`,
    `                <timestamp>`,
    `                    <fieldName>ts</fieldName>`,
    `                    <timeZone>UTC</timeZone>`,
    `                    <pattern>yyyy-MM-dd'T'HH:mm:ss.SSSXXX</pattern>`,
    `                </timestamp>`,
    `                <mdc>`,
    `                    <includeMdcKeyName>correlation_id</includeMdcKeyName>`,
    `                    <includeMdcKeyName>scope_id</includeMdcKeyName>`,
    `                    <includeMdcKeyName>actor_id</includeMdcKeyName>`,
    `                    <mdcKeyFieldName>correlation_id=request_id</mdcKeyFieldName>`,
    `                </mdc>`,
    `                <keyValuePairs/>`,
    `            </providers>`,
    `        </encoder>`,
    `    </appender>`,
    ``,
    `    <!-- Catalog events are gated in CatalogLog by LOG_LEVEL; keep the logger`,
    `         open (TRACE) so logback doesn't filter a second time.`,
    `         additivity=false keeps the JSON lines off the CONSOLE appender. -->`,
    `    <logger name="loomCatalog" level="TRACE" additivity="false">`,
    `        <appender-ref ref="CATALOG"/>`,
    `    </logger>`,
    ``,
    `    <root level="\${LOG_LEVEL:-INFO}">`,
    `        <appender-ref ref="CONSOLE"/>`,
    `    </root>`,
    `</configuration>`,
    ``,
  );
}

/** Flyway migration-lifecycle catalog events.  Spring Boot auto-configures
 *  Flyway and runs the emitted `db/migration/V*.sql` on boot; this callback
 *  hangs off that in-process run and surfaces the same
 *  migrations_starting / migration_applied / migrations_complete /
 *  migration_failed events the other backends emit — through CatalogLog, so
 *  they share the envelope.  Wired via a FlywayConfigurationCustomizer bean,
 *  emitted only when the project ships migrations. */
export function renderMigrationCatalogCallback(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import org.flywaydb.core.api.callback.Callback;`,
    `import org.flywaydb.core.api.callback.Context;`,
    `import org.flywaydb.core.api.callback.Event;`,
    `import org.springframework.boot.flyway.autoconfigure.FlywayConfigurationCustomizer;`,
    `import org.springframework.context.annotation.Bean;`,
    `import org.springframework.context.annotation.Configuration;`,
    ``,
    `/** Emits the cross-backend migration-lifecycle catalog events from Flyway's`,
    ` *  in-process boot run.  \`id\` = the migration version, \`name\` = its`,
    ` *  description; durations are Flyway's per-migration execution time. */`,
    `@Configuration`,
    `public class MigrationCatalogConfig {`,
    `    @Bean`,
    `    FlywayConfigurationCustomizer migrationCatalogCustomizer() {`,
    `        return configuration -> configuration.callbacks(new MigrationCatalogCallback());`,
    `    }`,
    ``,
    `    static final class MigrationCatalogCallback implements Callback {`,
    `        @Override`,
    `        public boolean supports(Event event, Context context) {`,
    `            return event == Event.BEFORE_MIGRATE`,
    `                || event == Event.AFTER_EACH_MIGRATE`,
    `                || event == Event.AFTER_MIGRATE`,
    `                || event == Event.AFTER_EACH_MIGRATE_ERROR`,
    `                || event == Event.AFTER_MIGRATE_ERROR;`,
    `        }`,
    ``,
    `        @Override`,
    `        public boolean canHandleInTransaction(Event event, Context context) {`,
    `            return true;`,
    `        }`,
    ``,
    `        @Override`,
    `        public void handle(Event event, Context context) {`,
    `            var info = context.getMigrationInfo();`,
    `            switch (event) {`,
    `                case BEFORE_MIGRATE -> CatalogLog.event("migrations_starting", "info");`,
    `                case AFTER_EACH_MIGRATE -> {`,
    `                    if (info != null) {`,
    `                        CatalogLog.event("migration_applied", "info",`,
    `                            "id", String.valueOf(info.getVersion()),`,
    `                            "name", info.getDescription(),`,
    `                            "duration_ms", info.getExecutionTime());`,
    `                    }`,
    `                }`,
    `                case AFTER_MIGRATE -> CatalogLog.event("migrations_complete", "info");`,
    `                case AFTER_EACH_MIGRATE_ERROR, AFTER_MIGRATE_ERROR -> {`,
    `                    if (info != null) {`,
    `                        CatalogLog.event("migration_failed", "error",`,
    `                            "id", String.valueOf(info.getVersion()),`,
    `                            "name", info.getDescription(),`,
    `                            "error", "migration failed");`,
    `                    } else {`,
    `                        CatalogLog.event("migration_failed", "error", "error", "migration failed");`,
    `                    }`,
    `                }`,
    `                default -> {`,
    `                }`,
    `            }`,
    `        }`,
    ``,
    `        @Override`,
    `        public String getCallbackName() {`,
    `            return "MigrationCatalogCallback";`,
    `        }`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderLifecycleCatalog(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import org.springframework.boot.context.event.ApplicationReadyEvent;`,
    `import org.springframework.context.event.ContextClosedEvent;`,
    `import org.springframework.context.event.EventListener;`,
    `import org.springframework.stereotype.Component;`,
    ``,
    `/** Server lifecycle catalog events (server_starting is printed by`,
    ` *  Application.main before the context boots). */`,
    `@Component`,
    `public class LifecycleCatalog {`,
    `    @EventListener(ApplicationReadyEvent.class)`,
    `    public void onReady() {`,
    `        CatalogLog.event("server_listening", "info");`,
    `    }`,
    ``,
    `    @EventListener(ContextClosedEvent.class)`,
    `    public void onClosed() {`,
    `        CatalogLog.event("server_shutdown", "info");`,
    `        CatalogLog.event("server_drained", "info");`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderRequestCatalogFilter(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import java.io.IOException;`,
    ``,
    `import org.springframework.stereotype.Component;`,
    `import org.springframework.web.filter.OncePerRequestFilter;`,
    `import org.springframework.web.servlet.HandlerMapping;`,
    ``,
    `import jakarta.servlet.FilterChain;`,
    `import jakarta.servlet.ServletException;`,
    `import jakarta.servlet.http.HttpServletRequest;`,
    `import jakarta.servlet.http.HttpServletResponse;`,
    ``,
    `/** Catalog request span — request_start / request_end with status +`,
    ` *  duration, the cross-backend access-log shape.  Also records the`,
    ` *  Prometheus HTTP metrics at the request_end seam. */`,
    `@Component`,
    `public class RequestCatalogFilter extends OncePerRequestFilter {`,
    `    private final HttpMetrics metrics;`,
    ``,
    `    public RequestCatalogFilter(HttpMetrics metrics) {`,
    `        this.metrics = metrics;`,
    `    }`,
    ``,
    `    @Override`,
    `    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)`,
    `            throws ServletException, IOException {`,
    `        var startedAt = System.nanoTime();`,
    `        CatalogLog.event("request_start", "info", "method", request.getMethod(), "path", request.getRequestURI());`,
    `        try {`,
    `            chain.doFilter(request, response);`,
    `        } finally {`,
    `            var durationMs = (System.nanoTime() - startedAt) / 1_000_000.0;`,
    `            CatalogLog.event(`,
    `                "request_end",`,
    `                "info",`,
    `                "method", request.getMethod(),`,
    `                "path", request.getRequestURI(),`,
    `                "status", response.getStatus(),`,
    `                "duration_ms", durationMs);`,
    // The matched handler pattern (`/api/carts/{id}`) is stashed on the
    // request by DispatcherServlet during chain.doFilter; read it here for a
    // bounded Prometheus `route` label, falling back to the raw URI.
    `            var pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);`,
    `            var route = pattern instanceof String s ? s : request.getRequestURI();`,
    `            metrics.record(request.getMethod(), route, response.getStatus(), durationMs);`,
    `        }`,
    `    }`,
    `}`,
    ``,
  );
}
