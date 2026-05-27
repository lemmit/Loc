// Regression test for the explicit-architecture migration of
// `examples/acme.ddd`.
//
// Earlier, acme.ddd was a one-line `scaffold
// modules: …` UI with bare `modules:` deployables.  After
// migration, the file declares api contracts, storage instances,
// UI api parameters, backend `serves:` lists, per-module storage
// maps, and a frontend ui-compose block — every architectural
// piece in one realistic example.
//
// This test pins the migrated shape so a future regression in
// any layer surfaces immediately.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ACME_PATH = path.resolve(here, "..", "..", "examples", "acme.ddd");

async function build() {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const src = readFileSync(ACME_PATH, "utf8");
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  return { doc, errors };
}

describe("examples/acme.ddd — explicit architecture migration", () => {
  it("parses and validates without errors", async () => {
    const { errors } = await build();
    expect(errors).toEqual([]);
  });

  it("declares all three api contracts at system scope", async () => {
    const { doc } = await build();
    const sys = lowerModel(doc.parseResult.value as Model).systems[0]!;
    const apiNames = sys.apis.map((a) => a.name).sort();
    expect(apiNames).toEqual(["CatalogApi", "CustomerMgmtApi", "SalesApi"]);
    // Each api derives from its module of the same root name.
    const sources = sys.apis.reduce<Record<string, string>>(
      (acc, a) => ({ ...acc, [a.name]: a.sourceModule }),
      {},
    );
    expect(sources).toEqual({
      CatalogApi: "Catalog",
      SalesApi: "Sales",
      CustomerMgmtApi: "CustomerMgmt",
    });
  });

  it("declares the primarySql storage", async () => {
    const { doc } = await build();
    const sys = lowerModel(doc.parseResult.value as Model).systems[0]!;
    expect(sys.storages.map((s) => `${s.name}:${s.type}`)).toEqual(["primarySql:postgres"]);
  });

  it("WebApp declares all three UI api parameters", async () => {
    const { doc } = await build();
    const sys = lowerModel(doc.parseResult.value as Model).systems[0]!;
    const ui = sys.uis.find((u) => u.name === "WebApp")!;
    expect(ui).toBeDefined();
    const params = ui.apiParams.map((p) => `${p.name}->${p.apiName}`).sort();
    expect(params).toEqual([
      "Catalog->CatalogApi",
      "CustomerMgmt->CustomerMgmtApi",
      "Sales->SalesApi",
    ]);
  });

  it("backend `api` deployable serves all three contracts + maps each module to primarySql", async () => {
    const { doc } = await build();
    const sys = lowerModel(doc.parseResult.value as Model).systems[0]!;
    const api = sys.deployables.find((d) => d.name === "api")!;
    expect(api).toBeDefined();
    expect(api.serves.sort()).toEqual(["CatalogApi", "CustomerMgmtApi", "SalesApi"]);
    // Each module's primary storage is primarySql.
    for (const mb of api.moduleBindings) {
      const primary = mb.storages.find((s) => s.role === "primary");
      expect(primary?.storageName).toBe("primarySql");
    }
  });

  it("frontend `webApp` deployable binds every UI param to the api backend", async () => {
    const { doc } = await build();
    const sys = lowerModel(doc.parseResult.value as Model).systems[0]!;
    const webApp = sys.deployables.find((d) => d.name === "webApp")!;
    expect(webApp).toBeDefined();
    const bindings = webApp.uiBindings
      .map((b) => `${b.paramName}->${b.sourceDeployableName}`)
      .sort();
    expect(bindings).toEqual(["Catalog->api", "CustomerMgmt->api", "Sales->api"]);
  });
});
