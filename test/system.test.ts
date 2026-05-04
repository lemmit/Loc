import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateSystems } from "../src/system/index.js";
import type { Model } from "../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc =
    await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(path.join(repoRoot, file)),
    );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return doc.parseResult.value as Model;
}

describe("system / module / deployable", () => {
  it("parses examples/acme.ddd without errors", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc =
      await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
        URI.file(path.join(repoRoot, "examples/acme.ddd")),
      );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
  });

  it("emits one project per deployable + docker-compose at the system root", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const keys = [...files.keys()];
    // Compose at the root.
    expect(keys).toContain("docker-compose.yml");
    // .NET deployable under api/, slug folder name, capitalised csproj.
    expect(keys).toContain("api/Api.csproj");
    expect(keys).toContain("api/Program.cs");
    expect(keys).toContain("api/Dockerfile");
    // Hono deployable under catalog_web/ (camelCase deployable name
    // slugged for docker / filesystem use).
    expect(keys).toContain("catalog_web/package.json");
    expect(keys).toContain("catalog_web/index.ts");
    expect(keys).toContain("catalog_web/Dockerfile");
  });

  it("scopes each deployable to its declared modules", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    // catalog_web (Hono, modules: Catalog) sees Product but NOT Order.
    expect(files.has("catalog_web/domain/product.ts")).toBe(true);
    expect(files.has("catalog_web/domain/order.ts")).toBe(false);
    // api (.NET, modules: Catalog, Sales) sees both.
    const apiFiles = [...files.keys()].filter((k) => k.startsWith("api/"));
    expect(apiFiles.some((k) => /Domain\/Products\/Product\.cs$/.test(k))).toBe(
      true,
    );
    expect(apiFiles.some((k) => /Domain\/Orders\/Order\.cs$/.test(k))).toBe(
      true,
    );
  });

  it("docker-compose.yml wires postgres + a healthcheck per deployable", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const compose = files.get("docker-compose.yml")!;
    expect(compose).toMatch(/image: postgres:16-alpine/);
    expect(compose).toMatch(/api:\s*\n\s*build: \.\/api/);
    expect(compose).toMatch(/catalog_web:\s*\n\s*build: \.\/catalog_web/);
    expect(compose).toMatch(/8080:8080/);
    expect(compose).toMatch(/3000:3000/);
    expect(compose).toMatch(/wget -qO- http:\/\/localhost:8080\/health/);
    expect(compose).toMatch(/wget -qO- http:\/\/localhost:3000\/health/);
  });

  it("emits a /health endpoint on each deployable", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const honoIndex = files.get("catalog_web/http/index.ts")!;
    expect(honoIndex).toMatch(/app\.get\("\/health"/);
    const dotnetProgram = files.get("api/Program.cs")!;
    expect(dotnetProgram).toMatch(/app\.MapGet\("\/health"/);
  });

  it("rejects `generate system` on a file with no system blocks", async () => {
    // Legacy bare-context files don't have a system; generateSystems
    // returns an empty file map.
    const model = await buildModel("examples/sales.ddd");
    const { files } = generateSystems(model);
    expect(files.size).toBe(0);
  });
});
