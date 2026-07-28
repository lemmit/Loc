// Auto-generated.
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/** The tracer every request seam opens its SERVER span from.  Falls
 *  back to the global no-op tracer if provider setup throws (e.g. a
 *  browser-bundled runtime), so importing this module never crashes
 *  boot. */
export let tracer = trace.getTracer("loom");

let provider: BasicTracerProvider | undefined;

try {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // A span is created on every request so `trace_id` rides the logs;
  // spans are EXPORTED only when an OTLP collector endpoint is set.  The
  // exporter posts to the standard `/v1/traces` path (trailing slash on
  // the endpoint tolerated).
  const spanProcessors = endpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
          }),
        ),
      ]
    : [];
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "catalogWeb",
    }),
    spanProcessors,
  });
  trace.setGlobalTracerProvider(provider);
  tracer = trace.getTracer("loom");
} catch {
  // Non-standard runtime: fall back to the no-op tracer (spans become
  // no-ops; the backend still boots and serves).
}

/** Flush + shut down the span exporter on server drain, so buffered
 *  spans reach the collector before the process exits.  No-op when no
 *  provider was created. */
export async function shutdownTracing(): Promise<void> {
  try {
    await provider?.forceFlush();
    await provider?.shutdown();
  } catch {
    /* best-effort */
  }
}
