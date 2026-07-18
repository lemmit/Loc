// Prometheus /metrics on the Java/Spring backend (M-T7.1).  Actuator +
// micrometer-registry-prometheus expose the exposition (remapped to
// /metrics in application.yml); catalog-named Micrometer meters
// (http_requests_total / http_request_duration_seconds) are recorded from
// RequestCatalogFilter's request_end seam, labelled by the matched route
// template.  Runtime contract gated by observability-events-java.test.ts
// (LOOM_OBS_E2E_JAVA=1).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
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
  }
}
`;

function get(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `expected a generated file ending in ${suffix}`).toBeDefined();
  return files.get(key!)!;
}

describe("Java Prometheus metrics", () => {
  it("emits the catalog-driven Micrometer meters + /metrics wiring", async () => {
    const files = await generateSystemFiles(SYSTEM);

    // Catalog-named meters (src/generator/_obs/metrics.ts).
    const metrics = get(files, "/config/HttpMetrics.java");
    expect(metrics).toContain('Counter.builder("http.requests")');
    expect(metrics).toContain('Timer.builder("http.request.duration")');
    expect(metrics).toContain(".serviceLevelObjectives(");
    expect(metrics).toContain(
      "public void record(String method, String route, int status, double durationMs) {",
    );

    // Recorded at the request_end seam, labelled by the matched route template.
    const filter = get(files, "/config/RequestCatalogFilter.java");
    expect(filter).toContain("public RequestCatalogFilter(HttpMetrics metrics) {");
    expect(filter).toContain("HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE");
    expect(filter).toContain("metrics.record(request.getMethod(), route, response.getStatus()");

    // Build + config: actuator + prometheus registry, exposition remapped to /metrics.
    const gradle = get(files, "/build.gradle.kts");
    expect(gradle).toContain("spring-boot-starter-actuator");
    expect(gradle).toContain("io.micrometer:micrometer-registry-prometheus");
    const yml = get(files, "/application.yml");
    expect(yml).toContain("include: prometheus");
    expect(yml).toContain("prometheus: metrics");
  });
});
