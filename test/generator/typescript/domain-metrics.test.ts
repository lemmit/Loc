// Per-operation / domain-fault Prometheus counters on the Hono backend
// (M-T7.1).  Every domain operation increments domain_operations_total
// {aggregate, op} at the same seam as the operation_invoked log line, and
// every recoverable fault increments domain_faults_total{aggregate, kind}
// in the router's onError alongside the matching fault log line.  Runtime
// contract gated by observability-events.test.ts (LOOM_OBS_E2E=1).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        status: string
        operation confirm() { status := "confirmed" }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable api { platform: node contexts: [Orders] serves: OrdersApi dataSources: [st] port: 8080 }
}`;

function get(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `expected a generated file ending in ${suffix}`).toBeDefined();
  return files.get(key!)!;
}

describe("Hono domain metrics (M-T7.1)", () => {
  it("emits the catalog-driven domain counters + record helpers in obs/metrics.ts", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const metrics = get(files, "/obs/metrics.ts");
    expect(metrics).toContain('"domain_operations_total"');
    expect(metrics).toContain('"domain_faults_total"');
    expect(metrics).toContain('labelNames: ["aggregate", "op"]');
    expect(metrics).toContain('labelNames: ["aggregate", "kind"]');
    expect(metrics).toContain(
      "export function recordDomainOperation(aggregate: string, op: string): void {",
    );
    expect(metrics).toContain(
      "export function recordDomainFault(aggregate: string, kind: string): void {",
    );
  });

  it("records operations + faults at the domain seams in the routes file", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const routes = get(files, "/http/order.routes.ts");
    expect(routes).toContain(
      'import { recordDomainFault, recordDomainOperation } from "../obs/metrics"',
    );
    // Operation invoked → operation counter (op name), create → op="create".
    expect(routes).toContain('recordDomainOperation("Order", "confirm")');
    expect(routes).toContain('recordDomainOperation("Order", "create")');
    // Faults in onError → fault counter, keyed by the catalog kind.
    expect(routes).toContain('recordDomainFault("Order", "forbidden")');
    expect(routes).toContain('recordDomainFault("Order", "domain_error")');
    expect(routes).toContain('recordDomainFault("Order", "not_found")');
  });
});
