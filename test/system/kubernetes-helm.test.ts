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
    const secret = files.get("helm/templates/db-secret.yaml")!;
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
    // Backend gets none.
    expect(files.has("helm/templates/api-ingress.yaml")).toBe(false);
    // Default-off ⇒ raw render (default values) omits ingress entirely.
    expect([...files.keys()].some((p) => p.startsWith("k8s/") && p.includes("ingress"))).toBe(
      false,
    );
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
