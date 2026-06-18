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
  deployable api { platform: hono contexts: [Products] serves: ShopApi dataSources: [st] port: 8080 }
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

  it("aligns probes to /health (liveness) + /ready (readiness) regardless of compose healthPath", async () => {
    const files = await filesFor(JAVA_SRC, true);
    const dep = files.get("k8s/api-deployment.yaml")!;
    // Both endpoints exist on every backend; liveness is the cheap one.
    expect(dep).toMatch(/livenessProbe[\s\S]*?path: \/health/);
    expect(dep).toMatch(/readinessProbe[\s\S]*?path: \/ready/);
  });
});
