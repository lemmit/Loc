// Execution-context carrier on the Java/Spring backend (docs/architecture/
// request-context.md).  MVC has no AsyncLocal, so the carrier rides SLF4J MDC:
// an ExecutionContextFilter at the HTTP edge (outermost, HIGHEST_PRECEDENCE) mints/
// propagates the correlation id from X-Correlation-Id || X-Request-Id, stamps
// the request-stable tier + root scope_id into MDC, echoes X-Correlation-Id, and
// clears MDC on the way out.  UserFilter stamps the principal's actor_id (only
// the id; the full principal stays on CurrentUserAccessor).  A RequestContext
// class exposes static accessors for non-HTTP reads.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (deployableExtra: string) => `
system S {
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        status: string
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8080
${deployableExtra}
  }
}
`;

function get(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `expected a generated file ending in ${suffix}`).toBeDefined();
  return files.get(key!)!;
}

describe("Java execution-context carrier", () => {
  it("emits the RequestContext carrier + the HTTP-edge filter (always-on, no auth)", async () => {
    const files = await generateSystemFiles(SYSTEM(""));

    const rc = get(files, "/config/RequestContext.java");
    // MDC-backed accessors for non-HTTP reads.
    expect(rc).toContain("import org.slf4j.MDC;");
    expect(rc).toContain("public static String correlationId() {");
    expect(rc).toContain("return MDC.get(CORRELATION_ID);");
    expect(rc).toContain("public static String scopeId() {");
    expect(rc).toContain("public static String parentId() {");
    expect(rc).toContain("public static String actorId() {");
    expect(rc).toContain("public static long startedAt() {");
    // The actor-id stamp helper (only the id rides MDC).
    expect(rc).toContain("public static void putActorId(String id) {");
    expect(rc).toContain("MDC.put(ACTOR_ID, id);");

    // Named ExecutionContextFilter (not RequestContextFilter) so the @Component
    // bean name doesn't collide with Spring's auto-configured requestContextFilter.
    const filter = get(files, "/config/ExecutionContextFilter.java");
    expect(filter).toContain("public class ExecutionContextFilter extends OncePerRequestFilter {");
    // Outermost filter so the context is set before auth / catalog run.
    expect(filter).toContain("@Order(Ordered.HIGHEST_PRECEDENCE)");
    // Correlation id: X-Correlation-Id, then X-Request-Id, then mint.
    expect(filter).toContain(
      'private static final String CORRELATION_HEADER = "X-Correlation-Id";',
    );
    expect(filter).toContain('private static final String REQUEST_ID_HEADER = "X-Request-Id";');
    expect(filter).toContain("var correlation = request.getHeader(CORRELATION_HEADER);");
    expect(filter).toContain("var requestId = request.getHeader(REQUEST_ID_HEADER);");
    expect(filter).toContain("return RequestContext.newId();");
    // Stamps the request-stable tier + root scope_id into MDC.
    expect(filter).toContain("MDC.put(RequestContext.CORRELATION_ID, correlationId);");
    expect(filter).toContain("MDC.put(RequestContext.SCOPE_ID, RequestContext.newId());");
    expect(filter).toContain("MDC.put(RequestContext.LOCALE, resolveLocale(request));");
    // Echoes the correlation id, and clears MDC on the way out (thread hygiene).
    expect(filter).toContain("response.setHeader(CORRELATION_HEADER, correlationId);");
    expect(filter).toContain("MDC.clear();");
  });

  it("emits the per-dispatch child-frame seam (openChild → parent_id chaining)", async () => {
    const rc = get(await generateSystemFiles(SYSTEM("")), "/config/RequestContext.java");
    // openChild() opens a child frame: fresh scope_id, parent_id <- the caller's
    // scope_id, returned as an AutoCloseable Frame restored on close (try-with-
    // resources). A no-op outside a request (no current scope).
    expect(rc).toContain("public static Frame openChild() {");
    expect(rc).toContain("var parentScope = MDC.get(SCOPE_ID);");
    expect(rc).toContain("MDC.put(SCOPE_ID, newId());");
    expect(rc).toContain("MDC.put(PARENT_ID, parentScope);");
    expect(rc).toContain("return new Frame(parentScope, prevParent);");
    // The restore handle: close() pops back to the parent frame, no checked throw.
    expect(rc).toContain("public static final class Frame implements AutoCloseable {");
    expect(rc).toContain("public void close() {");
    expect(rc).toContain("MDC.put(SCOPE_ID, parentScope);");
    expect(rc).toContain("MDC.remove(PARENT_ID);");
  });

  it("CatalogLog logs through SLF4J; logback.xml renders the JSON envelope + MDC ids", async () => {
    // The catalog logs through SLF4J on a dedicated `loomCatalog` logger; the
    // JSON writing, string escaping, and MDC enrichment are the logging stack's
    // job (logstash-logback-encoder in logback.xml), NOT a hand-rolled writer.
    // request_id / scope_id / actor_id ride every request-scoped line via MDC so
    // logs join to the audit / provenance rows of the same frame.
    const files = await generateSystemFiles(SYSTEM(""));
    const catalog = get(files, "/config/CatalogLog.java");
    // Logs via SLF4J, not System.out — no hand-rolled JSON writer / escaper.
    expect(catalog).toContain('LoggerFactory.getLogger("loomCatalog")');
    expect(catalog).toContain("import org.slf4j.spi.LoggingEventBuilder;");
    expect(catalog).not.toContain("System.out.println");
    expect(catalog).not.toContain("StringBuilder");
    // Public API + call-site surface is unchanged (catalog-parity gates it).
    expect(catalog).toContain(
      "public static void event(String name, String level, Object... kvs) {",
    );
    // Envelope fields are structured key/value pairs the encoder serialises.
    expect(catalog).toContain('.addKeyValue("level", lvl)');
    expect(catalog).toContain('.addKeyValue("event", name)');
    expect(catalog).toContain("builder.addKeyValue(String.valueOf(kvs[i]), kvs[i + 1])");
    // Runtime level filtering: emission gated by LOG_LEVEL (default info),
    // trace folds to debug (Java has no trace level).
    expect(catalog).toContain('System.getenv("LOG_LEVEL")');
    expect(catalog).toContain('if (l.equals("trace")) {');

    // logback.xml wires the JSON envelope: ts from the timestamp provider, the
    // carrier ids from the whitelisted MDC keys (correlation_id → request_id).
    const logback = get(files, "src/main/resources/logback.xml");
    expect(logback).toContain(
      'class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder"',
    );
    expect(logback).toContain("<fieldName>ts</fieldName>");
    expect(logback).toContain("<includeMdcKeyName>correlation_id</includeMdcKeyName>");
    expect(logback).toContain("<includeMdcKeyName>scope_id</includeMdcKeyName>");
    expect(logback).toContain("<includeMdcKeyName>actor_id</includeMdcKeyName>");
    expect(logback).toContain("<mdcKeyFieldName>correlation_id=request_id</mdcKeyFieldName>");
    expect(logback).toContain("<keyValuePairs/>");
    // Catalog logger is dedicated + non-additive (JSON stays off the text console).
    expect(logback).toContain('<logger name="loomCatalog" level="TRACE" additivity="false">');
  });

  it("UserFilter stamps the principal's actor_id after the verifier succeeds", async () => {
    const files = await generateSystemFiles(
      `
system S {
  user {
    id: uuid
    role: string
  }
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        status: string
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8080
    auth: required
  }
}
`,
    );
    const userFilter = get(files, "/auth/UserFilter.java");
    expect(userFilter).toContain("import ");
    expect(userFilter).toContain(".config.RequestContext;");
    // The id field is named `id`, so the stamp reads user.id().
    expect(userFilter).toContain("RequestContext.putActorId(String.valueOf(user.id()));");
    // Stamped after the principal is set, before the chain proceeds.
    const setIdx = userFilter.indexOf("accessor.set(user);");
    const stampIdx = userFilter.indexOf("RequestContext.putActorId(");
    expect(setIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeGreaterThan(setIdx);
  });

  it("resolves the actor-id key from the user shape when there is no literal `id` field", async () => {
    const files = await generateSystemFiles(
      `
system S {
  user {
    userId: uuid
    role: string
  }
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        status: string
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8080
    auth: required
  }
}
`,
    );
    const userFilter = get(files, "/auth/UserFilter.java");
    // No field named `id` → falls back to the first declared field (userId).
    expect(userFilter).toContain("RequestContext.putActorId(String.valueOf(user.userId()));");
  });
});
