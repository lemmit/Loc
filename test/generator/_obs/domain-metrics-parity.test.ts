// Cross-backend domain-metrics parity (M-T7.1).  The neutral metric catalog
// (src/generator/_obs/metrics.ts) pins two business counters —
// domain_operations_total{aggregate,op} and domain_faults_total{kind} — and
// every backend must (a) declare both counters and (b) record them at the
// domain seams: an operation increment at operation_invoked / aggregate_created
// and a fault increment at the app-wide error handler.  The other four backends
// increment manually (recordDomainOperation / recordDomainFault); Phoenix is
// declarative — the counters are defined in the Telemetry supervisor and fed by
// :telemetry.execute events at the seams.  Runtime contract gated per backend by
// the LOOM_OBS_E2E_* suites; this is the fast per-PR structural substitute.

import { describe, expect, it } from "vitest";
import { Metrics } from "../../../src/generator/_obs/metrics.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** One canonical single-backend system per platform — an aggregate with a
 *  named operation (→ operation_invoked) and crudish create (→ aggregate_created)
 *  so both operation seams fire, plus the always-emitted fault handler. */
function systemFor(platform: string, port: number): string {
  return `
system S {
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation confirm() { status := "confirmed" }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: ${port}
  }
}`;
}

function sourceFor(files: Map<string, string>, ext: string): string {
  return [...files.entries()]
    .filter(([k]) => k.endsWith(ext))
    .map(([, v]) => v)
    .join("\n");
}

describe("domain-metrics parity — catalog names are stable", () => {
  it("pins the two business counters + their label sets", () => {
    expect(Metrics.domainOperationsTotal.name).toBe("domain_operations_total");
    expect(Metrics.domainOperationsTotal.labels).toEqual(["aggregate", "op"]);
    // Fault counter is kind-only — several backends handle faults in a central
    // seam where the aggregate isn't in scope, so an aggregate label wouldn't
    // be uniform cross-backend.
    expect(Metrics.domainFaultsTotal.name).toBe("domain_faults_total");
    expect(Metrics.domainFaultsTotal.labels).toEqual(["kind"]);
  });
});

// Each backend: (metric name it declares the counter under, operation seam
// marker, fault seam marker).  Names diverge by client library — Micrometer /
// Telemetry.Metrics dotted names map to the underscored Prometheus name.
const BACKENDS: Array<{
  platform: string;
  port: number;
  ext: string;
  // Substrings that must appear in the emitted source of that extension.
  declares: string[];
  opSeam: string[];
  faultSeam: string[];
}> = [
  {
    platform: "node",
    port: 8080,
    ext: ".ts",
    declares: ['"domain_operations_total"', '"domain_faults_total"'],
    opSeam: [
      'recordDomainOperation("Order", "confirm")',
      'recordDomainOperation("Order", "create")',
    ],
    faultSeam: ['recordDomainFault("domain_error")', 'recordDomainFault("not_found")'],
  },
  {
    platform: "dotnet",
    port: 8081,
    ext: ".cs",
    declares: ['"domain_operations_total"', '"domain_faults_total"'],
    opSeam: [
      'RecordDomainOperation("Order", "confirm")',
      'RecordDomainOperation("Order", "create")',
    ],
    faultSeam: ['RecordDomainFault("domain_error")', 'RecordDomainFault("not_found")'],
  },
  {
    platform: "java",
    port: 8082,
    ext: ".java",
    declares: ['Counter.builder("domain.operations")', 'Counter.builder("domain.faults")'],
    opSeam: [
      'httpMetrics.recordDomainOperation("Order", "confirm")',
      'httpMetrics.recordDomainOperation("Order", "create")',
    ],
    faultSeam: [
      'httpMetrics.recordDomainFault("domain_error")',
      'httpMetrics.recordDomainFault("not_found")',
    ],
  },
  {
    platform: "python",
    port: 8083,
    ext: ".py",
    declares: ['"domain_operations_total"', '"domain_faults_total"'],
    opSeam: [
      'record_domain_operation("Order", "confirm")',
      'record_domain_operation("Order", "create")',
    ],
    faultSeam: ['record_domain_fault("domain_error")', 'record_domain_fault("not_found")'],
  },
  {
    platform: "elixir",
    port: 8084,
    ext: ".ex",
    // Phoenix is declarative: counters defined in the Telemetry supervisor,
    // fed by [:loom, :domain, :*] :telemetry events at the seams.
    declares: ['counter("domain.operations.total"', 'counter("domain.faults.total"'],
    opSeam: [
      ':telemetry.execute([:loom, :domain, :operation], %{count: 1}, %{aggregate: "Order", op: "confirm"})',
      ':telemetry.execute([:loom, :domain, :operation], %{count: 1}, %{aggregate: "Order", op: "create"})',
    ],
    faultSeam: [
      ':telemetry.execute([:loom, :domain, :fault], %{count: 1}, %{kind: "domain_error"})',
      ':telemetry.execute([:loom, :domain, :fault], %{count: 1}, %{kind: "not_found"})',
    ],
  },
];

describe("domain-metrics parity — every backend declares + records both counters", () => {
  for (const b of BACKENDS) {
    it(`${b.platform}: declares the counters and records at the operation + fault seams`, async () => {
      const files = await generateSystemFiles(systemFor(b.platform, b.port));
      const src = sourceFor(files, b.ext);
      for (const needle of b.declares) {
        expect(src, `${b.platform} must declare ${needle}`).toContain(needle);
      }
      for (const needle of b.opSeam) {
        expect(src, `${b.platform} must record ${needle}`).toContain(needle);
      }
      for (const needle of b.faultSeam) {
        expect(src, `${b.platform} must record ${needle}`).toContain(needle);
      }
    });
  }
});
