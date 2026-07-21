// Opt-in k8s/helm deployment artifacts (D-K8S-*; docs/kubernetes.md).
// `generate system --k8s` emits a Helm chart (helm/) + raw manifests (k8s/)
// ALONGSIDE the always-present docker-compose.yml.  These tests pin the
// emitter-only contract: compose is never replaced, the DB connection is a
// Secret (external/managed), backends are ClusterIP, frontends get a gated
// Ingress.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function filesFor(src: string, emitKubernetes: boolean): Promise<Map<string, string>> {
  const doc = await parse(src, { validation: false });
  return generateSystems(doc.parseResult.value, { emitKubernetes }).files;
}

// A backend (hono, needs DB) + a react frontend that targets it.
const SRC = `
system Shop {
  subdomain Catalog {
    context Products {
      aggregate Product { name: string  price: int }
      repository Products for Product { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Products, kind: state, use: primary }
  api ShopApi from Catalog
  ui Storefront with scaffold(subdomains: [Catalog]) { }
  deployable api { platform: node contexts: [Products] serves: ShopApi dataSources: [st] port: 8080 }
  deployable web { platform: react targets: api ui: Storefront port: 3000 }
}`;

describe("kubernetes / helm emitter", () => {
  it("emits nothing under helm/ or k8s/ without the switch", async () => {
    const files = await filesFor(SRC, false);
    expect(files.has("docker-compose.yml")).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith("helm/"))).toBe(false);
    expect([...files.keys()].some((p) => p.startsWith("k8s/"))).toBe(false);
  });

  it("emits the chart + raw manifests ALONGSIDE compose with --k8s", async () => {
    const files = await filesFor(SRC, true);
    // Compose is never replaced.
    expect(files.has("docker-compose.yml")).toBe(true);
    // Chart skeleton.
    expect(files.has("helm/Chart.yaml")).toBe(true);
    expect(files.has("helm/values.yaml")).toBe(true);
    expect(files.has("helm/templates/_helpers.tpl")).toBe(true);
    expect(files.has("helm/templates/NOTES.txt")).toBe(true);
    // One deployment + service per deployable, k8s-safe (hyphenated) names.
    expect(files.has("helm/templates/api-deployment.yaml")).toBe(true);
    expect(files.has("helm/templates/api-service.yaml")).toBe(true);
    expect(files.has("helm/templates/web-deployment.yaml")).toBe(true);
    // Raw render mirror.
    expect(files.has("k8s/api-deployment.yaml")).toBe(true);
    expect(files.has("k8s/web-service.yaml")).toBe(true);
  });

  it("routes the DB connection through a Secret, not inline env", async () => {
    const files = await filesFor(SRC, true);
    const dep = files.get("helm/templates/api-deployment.yaml")!;
    expect(dep).toContain("secretKeyRef");
    expect(dep).toContain("DATABASE_URL");
    // The dev connection string is NOT baked into the deployment.
    expect(dep).not.toContain("postgres://postgres:postgres@db");
    // The Secret carries the (placeholder) url via values.
    const secret = files.get("helm/templates/secret.yaml")!;
    expect(secret).toContain("kind: Secret");
    expect(secret).toContain(".Values.api.database.url");
    // values.yaml keeps the dev-compose string as the placeholder default.
    expect(files.get("helm/values.yaml")!).toContain("postgres://postgres:postgres@db:5432/api");
  });

  it("makes backends ClusterIP and only frontends get an (off-by-default) Ingress", async () => {
    const files = await filesFor(SRC, true);
    expect(files.get("helm/templates/api-service.yaml")!).toContain("type: ClusterIP");
    // Frontend gets an ingress template, gated on values.
    const ing = files.get("helm/templates/web-ingress.yaml")!;
    expect(ing).toContain("{{- if .Values.web.ingress.enabled }}");
    expect(ing).toContain("kind: Ingress");
    // Same-origin split: the SPA `targets: api`, so one host fronts both —
    // `/api` → the backend service (port 8080) and `/` → the SPA (port 3000).
    expect(ing).toContain("- path: /api");
    expect(ing).toMatch(/- path: \/api[\s\S]*name: {{ include "loom\.fullname" \. }}-api/);
    expect(ing).toMatch(/- path: \/api[\s\S]*number: 8080/);
    expect(ing).toMatch(/- path: \/\n[\s\S]*name: {{ include "loom\.fullname" \. }}-web/);
    expect(ing).toMatch(/- path: \/\n[\s\S]*number: 3000/);
    // `/api` must precede the `/` catch-all so the longer prefix wins.
    expect(ing.indexOf("- path: /api")).toBeLessThan(ing.indexOf("- path: /\n"));
    // Backend gets none.
    expect(files.has("helm/templates/api-ingress.yaml")).toBe(false);
    // Default-off ⇒ raw render (default values) omits ingress entirely.
    expect([...files.keys()].some((p) => p.startsWith("k8s/") && p.includes("ingress"))).toBe(
      false,
    );
  });

  it("gates every per-deployable workload on a default-true `enabled` flag", async () => {
    const files = await filesFor(SRC, true);
    // values.yaml carries the toggle per deployable, defaulting on.
    const values = files.get("helm/values.yaml")!;
    expect(values).toMatch(/api:\n(?:.*\n)*?\s+enabled: true/);
    expect(values).toMatch(/web:\n(?:.*\n)*?\s+enabled: true/);
    // Each workload template is wrapped so `--set <key>.enabled=false` drops it
    // (install one backend at a time) without touching the rendered default.
    for (const f of ["api-deployment", "api-service", "web-deployment", "web-service"]) {
      const tpl = files.get(`helm/templates/${f}.yaml`)!;
      const key = f.startsWith("api") ? "api" : "web";
      expect(tpl.startsWith(`{{- if .Values.${key}.enabled }}\n`)).toBe(true);
      expect(tpl.trimEnd().endsWith("{{- end }}")).toBe(true);
    }
    // The frontend ingress keeps its own inner gate, nested under `enabled`.
    const ing = files.get("helm/templates/web-ingress.yaml")!;
    expect(ing.startsWith("{{- if .Values.web.enabled }}\n")).toBe(true);
    expect(ing).toContain("{{- if .Values.web.ingress.enabled }}");
  });

  it("gives the backend a DB-aware readiness probe and a cheap liveness probe", async () => {
    const files = await filesFor(SRC, true);
    const dep = files.get("k8s/api-deployment.yaml")!;
    expect(dep).toContain("livenessProbe");
    expect(dep).toContain("path: /health");
    expect(dep).toContain("readinessProbe");
    expect(dep).toContain("path: /ready");
  });
});

// A Java backend carries SPRING_DATASOURCE_PASSWORD + a /health vs /ready
// split that diverges from its compose healthcheck — the two cases the
// secret-widening + probe-alignment rules exist for.
const JAVA_SRC = `
system Shop {
  subdomain Catalog {
    context Products {
      aggregate Product { name: string  price: int }
      repository Products for Product { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Products, kind: state, use: primary }
  api ShopApi from Catalog
  deployable api { platform: java contexts: [Products] serves: ShopApi dataSources: [st] port: 8080 }
}`;

describe("kubernetes / helm — secret widening + probe alignment", () => {
  it("routes a password env into the Secret, not the ConfigMap", async () => {
    const files = await filesFor(JAVA_SRC, true);
    const config = files.get("k8s/api-config.yaml")!;
    const secret = files.get("k8s/secret.yaml")!;
    // The password is a Secret entry…
    expect(secret).toContain("SPRING_DATASOURCE_PASSWORD".toLowerCase().replace(/_/g, "-"));
    expect(secret).toContain("kind: Secret");
    // …and never lands in the plaintext ConfigMap.
    expect(config).not.toContain("SPRING_DATASOURCE_PASSWORD");
    expect(config).not.toContain("postgres\n"); // password value not in config
    // The non-secret username stays config.
    expect(config).toContain("SPRING_DATASOURCE_USERNAME");
    const dep = files.get("k8s/api-deployment.yaml")!;
    expect(dep).toContain("name: SPRING_DATASOURCE_PASSWORD");
    expect(dep).toContain("secretKeyRef");
  });

  it("disables the interactive OpenAPI UI on backends by default (LOOM_OPENAPI_UI=false)", async () => {
    const files = await filesFor(JAVA_SRC, true);
    // Prod-hardening: the k8s ConfigMap turns off the Swagger UI / FastAPI docs;
    // the /openapi.json spec stays available.  Compose leaves it on (dev loop).
    expect(files.get("k8s/api-config.yaml")!).toContain("LOOM_OPENAPI_UI");
    expect(files.get("helm/templates/api-config.yaml")!).toContain("LOOM_OPENAPI_UI");
  });

  it("aligns probes to /health (liveness) + /ready (readiness) regardless of compose healthPath", async () => {
    const files = await filesFor(JAVA_SRC, true);
    const dep = files.get("k8s/api-deployment.yaml")!;
    // Both endpoints exist on every backend; liveness is the cheap one.
    expect(dep).toMatch(/livenessProbe[\s\S]*?path: \/health/);
    expect(dep).toMatch(/readinessProbe[\s\S]*?path: \/ready/);
  });
});

// Broker channel wiring (M-T4.4 slice 5b): a wired channelSource gets an
// enabled-gated in-cluster broker workload in the chart (+ raw view), and
// each wired deployable's LOOM_CHANNEL_*_URL rides the shared Secret with
// the §7 credentials — overridable per deployable via `channels:` values.
const BROKER_SRC = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: log
      }
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
      }
      repository Shipments for Shipment {}
      workflow Fulfil {
        orderId: Order id
        create(p: OrderPlaced) by p.order {
          let s = Shipment.create({ orderRef: p.order, status: "Pending" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: kafka }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: node contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: node contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}`;

describe("kubernetes / helm — broker channel wiring (M-T4.4 slice 5b)", () => {
  it("emits an enabled-gated broker workload in the chart with the §7 auth config", async () => {
    const files = await filesFor(BROKER_SRC, true);
    const broker = files.get("helm/templates/bus-broker.yaml") ?? "";
    expect(broker).toContain("{{- if .Values.brokers.bus.enabled }}");
    expect(broker).toContain("image: apache/kafka:4.1.0");
    // SASL/PLAIN on the client listener; advertised host = the release-
    // prefixed broker Service.
    expect(broker).toContain(
      'value: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,CLIENT:SASL_PLAINTEXT"',
    );
    expect(broker).toContain(
      'value: {{ printf "CLIENT://%[1]s-bus:9092,PLAINTEXT://%[1]s-bus:9094" (include "loom.fullname" .) | quote }}',
    );
    expect(broker).toContain(
      'user_sales_api=\\"loom-dev-bus-sales_api\\" user_ship_api=\\"loom-dev-bus-ship_api\\"',
    );
    const values = files.get("helm/values.yaml") ?? "";
    expect(values).toContain("brokers:");
    expect(values).toContain("  bus:\n    enabled: true");
    // Per-deployable channels override knob, empty by default.
    expect(values).toContain('    LOOM_CHANNEL_LIFECYCLE_BUS_URL: ""');
  });

  it("routes the credentialed channel URL through the shared Secret with an in-cluster default", async () => {
    const files = await filesFor(BROKER_SRC, true);
    const secret = files.get("helm/templates/secret.yaml") ?? "";
    expect(secret).toContain(
      'sales-api-loom-channel-lifecycle-bus-url: {{ .Values.salesApi.channels.LOOM_CHANNEL_LIFECYCLE_BUS_URL | default (printf "kafka://sales_api:loom-dev-bus-sales_api@%s-bus:9092" (include "loom.fullname" .)) | quote }}',
    );
    const deployment = files.get("helm/templates/sales-api-deployment.yaml") ?? "";
    expect(deployment).toContain("- name: LOOM_CHANNEL_LIFECYCLE_BUS_URL");
    expect(deployment).toContain("key: sales-api-loom-channel-lifecycle-bus-url");
  });

  it("mirrors the broker + secret into the raw k8s/ view with plain service names", async () => {
    const files = await filesFor(BROKER_SRC, true);
    const broker = files.get("k8s/bus-broker.yaml") ?? "";
    expect(broker).toContain("image: apache/kafka:4.1.0");
    expect(broker).toContain('value: "CLIENT://bus:9092,PLAINTEXT://bus:9094"');
    const secret = files.get("k8s/secret.yaml") ?? "";
    expect(secret).toContain(
      'sales-api-loom-channel-lifecycle-bus-url: "kafka://sales_api:loom-dev-bus-sales_api@bus:9092"',
    );
  });

  it("mounts the generated rabbit definitions via a ConfigMap on a rabbitmq storage", async () => {
    const rabbitSrc = BROKER_SRC.replace("type: kafka", "type: rabbitmq")
      .replace("delivery: broadcast", "delivery: queue")
      .replace("retention: log", "retention: work");
    const files = await filesFor(rabbitSrc, true);
    const broker = files.get("helm/templates/bus-broker.yaml") ?? "";
    expect(broker).toContain("kind: ConfigMap");
    expect(broker).toContain("loom-definitions.json: |");
    expect(broker).toContain('"hashing_algorithm": "rabbit_password_hashing_sha256"');
    expect(broker).toContain("mountPath: /etc/rabbitmq/loom-definitions.json");
    expect(broker).toContain("image: rabbitmq:4-management-alpine");
  });

  it("emits no broker artifacts for a channel-less system", async () => {
    const files = await filesFor(SRC, true);
    for (const path of files.keys()) {
      expect(path).not.toContain("-broker.yaml");
    }
    expect(files.get("helm/values.yaml")).not.toContain("brokers:");
  });
});
