// OpenTelemetry tracing (M-T7.1): the .NET backend registers AspNetCore
// instrumentation (a SERVER span per request) with a conditional OTLP/HTTP
// exporter, stamps the loom.* execution-context ids onto Activity.Current,
// and threads the span's trace_id/span_id onto the log scope so every
// request-scoped line joins to its trace.  The runtime contract is gated by
// observability-events-dotnet.test.ts (LOOM_OBS_E2E_DOTNET=1); this pins the
// emitter shape.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe(".NET OpenTelemetry tracing", () => {
  it("registers AspNetCore instrumentation + conditional OTLP export", async () => {
    const files = generateDotnet(await buildModel("examples/sales.ddd"));
    const program = files.get("Program.cs")!;
    expect(program).toContain("builder.Services.AddOpenTelemetry()");
    expect(program).toContain(".WithTracing(");
    expect(program).toContain("t.AddAspNetCoreInstrumentation();");
    // Export is env-gated: the OTLP exporter is wired only when the endpoint
    // env is set (a span is still created every request so trace_id rides logs).
    expect(program).toContain('GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT")');
    expect(program).toContain("if (!string.IsNullOrWhiteSpace(otlpEndpoint))");
    expect(program).toContain("t.AddOtlpExporter(");
    expect(program).toContain("OtlpExportProtocol.HttpProtobuf");
    // service.name honours OTEL_SERVICE_NAME (compose sets the slug).
    expect(program).toContain('GetEnvironmentVariable("OTEL_SERVICE_NAME")');
  });

  it("stamps the loom ids onto the span + threads trace_id/span_id onto the log scope", async () => {
    const files = generateDotnet(await buildModel("examples/sales.ddd"));
    const mw = files.get("Middleware/RequestContextMiddleware.cs")!;
    expect(mw).toContain("var activity = Activity.Current;");
    expect(mw).toContain('activity?.SetTag("loom.correlation_id", correlationId);');
    expect(mw).toContain('activity?.SetTag("loom.scope_id", rootFrame.ScopeId);');
    // trace_id / span_id ride the BeginScope dict (the .NET carrier's Scopes
    // array — the same channel scopeId rides).
    expect(mw).toContain('["traceId"] = activity?.TraceId.ToString(),');
    expect(mw).toContain('["spanId"] = activity?.SpanId.ToString(),');
  });

  it("pins the OTel package references on the csproj", async () => {
    const files = generateDotnet(await buildModel("examples/sales.ddd"));
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).toContain('Include="OpenTelemetry.Extensions.Hosting"');
    expect(csproj).toContain('Include="OpenTelemetry.Instrumentation.AspNetCore"');
    expect(csproj).toContain('Include="OpenTelemetry.Exporter.OpenTelemetryProtocol"');
  });
});
