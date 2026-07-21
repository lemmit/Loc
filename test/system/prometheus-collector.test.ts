// Prometheus collector wiring (M-T7.1).  Every backend deployable exposes
// GET /metrics; the system composer wires a Prometheus collector into the
// generated docker-compose.yml (scraping each backend via the mounted
// monitoring/prometheus.yml) and stamps prometheus.io scrape-discovery
// annotations onto each backend's k8s pod template.  Pure static frontends
// emit no metrics and are excluded from both.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function filesFor(src: string): Promise<Map<string, string>> {
  const doc = await parse(src, { validation: false });
  return generateSystems(doc.parseResult.value, { emitKubernetes: true }).files;
}

// A backend (node) + a static React frontend targeting it.
const SYSTEM = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { total: int }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable api { platform: node contexts: [Orders] serves: OrdersApi dataSources: [st] port: 8080 }
  ui web { for: OrdersApi }
  deployable webApp { platform: react ui: web targets: api port: 3000 }
}`;

describe("Prometheus collector wiring (M-T7.1)", () => {
  it("adds a prometheus service + scrape config for backends, excludes the frontend", async () => {
    const files = await filesFor(SYSTEM);
    const compose = files.get("docker-compose.yml")!;
    // The collector service.
    expect(compose).toContain("prometheus:");
    expect(compose).toContain("image: prom/prometheus:");
    expect(compose).toContain("/etc/prometheus/prometheus.yml:ro");
    expect(compose).toContain('- "9090:9090"');

    // Scrape config — a job for the backend, none for the react frontend.
    const cfg = files.get("monitoring/prometheus.yml")!;
    expect(cfg).toBeDefined();
    expect(cfg).toContain("metrics_path: /metrics");
    expect(cfg).toContain("job_name: api");
    expect(cfg).toContain('targets: ["api:3000"]');
    expect(cfg).not.toContain("job_name: web_app");
  });

  it("stamps prometheus.io scrape annotations onto backend pods only (k8s + helm)", async () => {
    const files = await filesFor(SYSTEM);
    const apiDeploy = files.get("k8s/api-deployment.yaml")!;
    expect(apiDeploy).toContain('prometheus.io/scrape: "true"');
    expect(apiDeploy).toContain('prometheus.io/port: "3000"');
    expect(apiDeploy).toContain("prometheus.io/path: /metrics");
    // The static frontend pod carries no scrape annotation.
    const webDeploy = files.get("k8s/web-app-deployment.yaml")!;
    expect(webDeploy).not.toContain("prometheus.io/scrape");
    // Helm chart deployment template has the same annotations.
    const helmDeploy = [...files.keys()].find(
      (k) => k.includes("templates") && k.includes("api") && k.endsWith("deployment.yaml"),
    );
    if (helmDeploy) {
      expect(files.get(helmDeploy)!).toContain('prometheus.io/scrape: "true"');
    }
  });
});
