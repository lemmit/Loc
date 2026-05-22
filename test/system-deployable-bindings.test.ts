import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmptyFileSystem } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";
import {
  deployableModules,
  deployableServes,
  deployableTargets,
  setDeployableModules,
  setDeployableServes,
  setDeployableTargets,
  setDeployableUi,
  uiKind,
} from "../web/src/builder/system/deployable-bindings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const acme = readFileSync(path.join(here, "..", "examples", "acme.ddd"), "utf8");
const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
function deployable(name: string): { $type: string } {
  const m = parser.parse(acme).value as Model;
  for (const n of (function* walk(x: { $type: string }): Generator<{ $type: string }> {
    yield x;
    for (const v of Object.values(x)) {
      if (Array.isArray(v)) for (const c of v) if (c && typeof c === "object" && "$type" in c) yield* walk(c);
      else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
    }
  })(m)) {
    if (n.$type === "Deployable" && (n as { name?: string }).name === name) return n;
  }
  throw new Error(`no deployable ${name}`);
}

describe("System builder — deployable bindings", () => {
  it("reads modules / serves / targets / ui kind", () => {
    expect(deployableModules(deployable("catalogWeb"))).toEqual(["Catalog", "CustomerMgmt"]);
    expect(deployableServes(deployable("catalogWeb"))).toEqual(["CatalogApi", "CustomerMgmtApi"]);
    expect(deployableTargets(deployable("webApp"))).toBe("api");
    expect(uiKind(deployable("webApp"))).toBe("compose"); // `ui: WebApp { … }` — advanced, hidden from the picker
    expect(uiKind(deployable("catalogWeb"))).toBe("none");
  });

  it("edits the module set, preserving existing storage maps", () => {
    // Add Sales (bare); keep Catalog / CustomerMgmt with their `{ primary: primarySql }`.
    const out = setDeployableModules(acme, "catalogWeb", ["Catalog", "CustomerMgmt", "Sales"])!;
    expect(out).toMatch(/Catalog\s*\{ primary: primarySql \}/);
    expect(out).toMatch(/CustomerMgmt\s*\{ primary: primarySql \}/);
    expect(out).toMatch(/Sales/);
    // Removing down to one keeps its storage map.
    expect(setDeployableModules(acme, "catalogWeb", ["Catalog"])).toMatch(/modules: Catalog \{ primary: primarySql \}/);
  });

  it("edits serves and targets", () => {
    expect(setDeployableServes(acme, "catalogWeb", ["CatalogApi"])).toMatch(/serves: CatalogApi\b/);
    expect(setDeployableTargets(acme, "webApp", "catalogApi")).toMatch(/targets: catalogApi/);
  });

  it("sets a sugar ui binding", () => {
    expect(setDeployableUi(acme, "catalogWeb", "WebApp")).toMatch(/ui: WebApp\b/);
  });

  it("returns null for an unknown deployable", () => {
    expect(setDeployableTargets(acme, "nope", "api")).toBeNull();
  });
});
