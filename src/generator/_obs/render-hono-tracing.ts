// ---------------------------------------------------------------------------
// Hono/OpenTelemetry renderer — emits the `obs/tracing.ts` module the
// generated Hono backend imports at its request seam (see the neutral
// `./tracing.ts` descriptor for the design).  Sister to
// `render-hono-metrics.ts`.
//
// One `BasicTracerProvider` per backend process.  A SERVER span is opened on
// every request (so `trace_id` always rides the logs — see the pino `mixin`
// in the observability builder), but spans are EXPORTED only when
// `OTEL_EXPORTER_OTLP_ENDPOINT` is set: the batch processor + OTLP/HTTP
// exporter are wired only then, so a local boot without the collector makes
// no export attempt.  `@opentelemetry/exporter-trace-otlp-http` sends JSON
// via fetch, so it also bundles cleanly for the browser playground (which
// never sets the endpoint → no exporter constructed).
// ---------------------------------------------------------------------------

import { lines } from "../../util/code-builder.js";
import { OTEL_ENDPOINT_ENV, OTEL_SERVICE_NAME_ENV } from "./tracing.js";

/** Render `obs/tracing.ts` — the tracer provider (conditional OTLP export)
 *  and the `tracer` + `shutdownTracing()` the request-id middleware + boot
 *  script consume.  `serviceName` is the default `service.name` resource
 *  attribute (the compose/k8s wiring overrides it via `OTEL_SERVICE_NAME`). */
export function renderHonoTracingFile(serviceName: string): string {
  return (
    lines(
      "// Auto-generated.",
      'import { trace } from "@opentelemetry/api";',
      'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";',
      'import { resourceFromAttributes } from "@opentelemetry/resources";',
      'import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";',
      'import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";',
      "",
      "/** The tracer every request seam opens its SERVER span from.  Falls",
      " *  back to the global no-op tracer if provider setup throws (e.g. a",
      " *  browser-bundled runtime), so importing this module never crashes",
      " *  boot. */",
      'export let tracer = trace.getTracer("loom");',
      "",
      "let provider: BasicTracerProvider | undefined;",
      "",
      "try {",
      `  const endpoint = process.env.${OTEL_ENDPOINT_ENV};`,
      "  // A span is created on every request so `trace_id` rides the logs;",
      "  // spans are EXPORTED only when an OTLP collector endpoint is set.  The",
      "  // exporter posts to the standard `/v1/traces` path (trailing slash on",
      "  // the endpoint tolerated).",
      "  const spanProcessors = endpoint",
      "    ? [",
      "        new BatchSpanProcessor(",
      "          new OTLPTraceExporter({",
      '            url: `${endpoint.replace(/\\/$/, "")}/v1/traces`,',
      "          }),",
      "        ),",
      "      ]",
      "    : [];",
      "  provider = new BasicTracerProvider({",
      "    resource: resourceFromAttributes({",
      `      [ATTR_SERVICE_NAME]: process.env.${OTEL_SERVICE_NAME_ENV} ?? ${JSON.stringify(serviceName)},`,
      "    }),",
      "    spanProcessors,",
      "  });",
      "  trace.setGlobalTracerProvider(provider);",
      '  tracer = trace.getTracer("loom");',
      "} catch {",
      "  // Non-standard runtime: fall back to the no-op tracer (spans become",
      "  // no-ops; the backend still boots and serves).",
      "}",
      "",
      "/** Flush + shut down the span exporter on server drain, so buffered",
      " *  spans reach the collector before the process exits.  No-op when no",
      " *  provider was created. */",
      "export async function shutdownTracing(): Promise<void> {",
      "  try {",
      "    await provider?.forceFlush();",
      "    await provider?.shutdown();",
      "  } catch {",
      "    /* best-effort */",
      "  }",
      "}",
    ) + "\n"
  );
}
