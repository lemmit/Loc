import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Observability catalog — JSON event lines on stdout, the cross-backend
// envelope the obs e2e suites assert:
//
//   server_starting → server_listening → request_start {method,path} →
//   request_end {status, durationMs} → server_shutdown → server_drained
//
// Emitted as flat JSON objects via a tiny writer (no logging-framework
// configuration to drift).  Mirrors dotnet's AddJsonConsole catalog and
// Hono's pino lines in event vocabulary.
// ---------------------------------------------------------------------------

export function renderCatalogLogger(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import org.slf4j.MDC;`,
    ``,
    `/** Catalog event writer — one flat JSON object per line on stdout.  The`,
    ` *  ambient carrier ids (request_id / scope_id / actor_id) ride every line`,
    ` *  emitted inside a request frame, read from MDC, so a log line joins to`,
    ` *  the audit / provenance rows of the same frame; omitted on boot-time`,
    ` *  lines (no frame). */`,
    `public final class CatalogLog {`,
    `    private CatalogLog() {`,
    `    }`,
    ``,
    `    /** kvs alternate key/value; values are JSON-escaped strings or raw numbers. */`,
    `    public static void event(String name, Object... kvs) {`,
    `        var sb = new StringBuilder("{\\"event\\":\\"").append(name).append('"');`,
    `        appendId(sb, "request_id", MDC.get(RequestContext.CORRELATION_ID));`,
    `        appendId(sb, "scope_id", MDC.get(RequestContext.SCOPE_ID));`,
    `        appendId(sb, "actor_id", MDC.get(RequestContext.ACTOR_ID));`,
    `        for (int i = 0; i + 1 < kvs.length; i += 2) {`,
    `            sb.append(",\\"").append(kvs[i]).append("\\":");`,
    `            var value = kvs[i + 1];`,
    `            if (value instanceof Number) {`,
    `                sb.append(value);`,
    `            } else {`,
    `                sb.append('"').append(escape(String.valueOf(value))).append('"');`,
    `            }`,
    `        }`,
    `        sb.append('}');`,
    `        System.out.println(sb);`,
    `    }`,
    ``,
    `    /** Append a carrier id when present (skipped on boot-time lines, where`,
    `     *  no request frame is active so MDC has no value). */`,
    `    private static void appendId(StringBuilder sb, String key, String value) {`,
    `        if (value != null) {`,
    `            sb.append(",\\"").append(key).append("\\":\\"").append(escape(value)).append('"');`,
    `        }`,
    `    }`,
    ``,
    `    private static String escape(String s) {`,
    `        return s.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"");`,
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
    `        CatalogLog.event("server_listening");`,
    `    }`,
    ``,
    `    @EventListener(ContextClosedEvent.class)`,
    `    public void onClosed() {`,
    `        CatalogLog.event("server_shutdown");`,
    `        CatalogLog.event("server_drained");`,
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
    ``,
    `import jakarta.servlet.FilterChain;`,
    `import jakarta.servlet.ServletException;`,
    `import jakarta.servlet.http.HttpServletRequest;`,
    `import jakarta.servlet.http.HttpServletResponse;`,
    ``,
    `/** Catalog request span — request_start / request_end with status +`,
    ` *  duration, the cross-backend access-log shape. */`,
    `@Component`,
    `public class RequestCatalogFilter extends OncePerRequestFilter {`,
    `    @Override`,
    `    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)`,
    `            throws ServletException, IOException {`,
    `        var startedAt = System.nanoTime();`,
    `        CatalogLog.event("request_start", "method", request.getMethod(), "path", request.getRequestURI());`,
    `        try {`,
    `            chain.doFilter(request, response);`,
    `        } finally {`,
    `            var durationMs = (System.nanoTime() - startedAt) / 1_000_000.0;`,
    `            CatalogLog.event(`,
    `                "request_end",`,
    `                "method", request.getMethod(),`,
    `                "path", request.getRequestURI(),`,
    `                "status", response.getStatus(),`,
    `                "durationMs", durationMs);`,
    `        }`,
    `    }`,
    `}`,
    ``,
  );
}
