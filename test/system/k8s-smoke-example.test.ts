// Guards the k8s cluster-smoke assets that live OUTSIDE the example matrices
// (scripts/k8s-e2e/): the dedicated multi-backend example and its write-
// round-trip fixture.  These are exercised for real only by the nightly
// k8s-e2e matrix, so this fast test pins that they parse, generate a gated
// workload per backend, and stay in sync with the fixture's endpoints.

import { readFileSync } from "node:fs";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

const DDD = "scripts/k8s-e2e/k8s-smoke.ddd";
const FIXTURE = "scripts/k8s-e2e/k8s-smoke.smoke.json";
// Backend workload names the k8s-e2e matrix fans across (see k8s-e2e.yml).
const BACKENDS = ["hono-api", "dotnet-api", "python-api", "java-api", "phoenix-api"];

describe("k8s cluster-smoke assets", () => {
  it("parses + validates with no errors", async () => {
    const doc = await parse(readFileSync(DDD, "utf8"), { validation: true });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(errors.map((d) => d.message)).toEqual([]);
  });

  it("emits a `enabled`-gated workload for every backend in the matrix", async () => {
    const doc = await parse(readFileSync(DDD, "utf8"), { validation: false });
    const files = generateSystems(doc.parseResult.value, { emitKubernetes: true }).files;
    for (const b of BACKENDS) {
      const dep = files.get(`helm/templates/${b}-deployment.yaml`);
      expect(dep, `${b}-deployment.yaml`).toBeDefined();
      // Wrapped so the matrix can install one backend at a time.
      expect(dep!.startsWith("{{- if .Values.")).toBe(true);
      expect(dep!).toContain(".enabled }}");
    }
  });

  it("keeps the fixture in sync with the example's endpoints", () => {
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    // The Widget aggregate ⇒ /widgets; the round-trip POSTs then reads back.
    expect(fx.create.path).toBe("/widgets");
    expect(fx.list).toBe("/widgets");
    expect(fx.idField).toBe("id");
    expect(typeof fx.create.body.name).toBe("string");
    expect(typeof fx.create.body.quantity).toBe("number");
  });
});
