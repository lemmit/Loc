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

  it("isolates each deployable to its own postgres database", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    // Init script runs once on first boot of an empty pgdata volume.
    const init = files.get("db-init/00-create-databases.sql")!;
    expect(init).toMatch(/CREATE DATABASE api;/);
    expect(init).toMatch(/CREATE DATABASE catalog_api;/);
    expect(init).toMatch(/CREATE DATABASE catalog_web;/);
    const compose = files.get("docker-compose.yml")!;
    // Postgres mounts the init script.
    expect(compose).toMatch(
      /\.\/db-init:\/docker-entrypoint-initdb\.d:ro/,
    );
    // Each deployable's connection string targets its own database.
    expect(compose).toMatch(/Database=api;/);
    expect(compose).toMatch(/Database=catalog_api;/);
    expect(compose).toMatch(/postgres:postgres@db:5432\/catalog_web/);
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

  it("lowers `test e2e` blocks to a vitest file with typed fetch calls", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/Acme.e2e.test.ts")!;
    expect(e2e).toMatch(/import \{ describe, it, expect \} from "vitest"/);
    // Endpoint table per deployable.
    expect(e2e).toMatch(/api: process\.env\.E2E_API_BASE/);
    expect(e2e).toMatch(/catalog_web: process\.env\.E2E_CATALOG_WEB_BASE/);
    // POST /products with a JSON body for `api.products.create({...})`.
    expect(e2e).toMatch(
      /__post\(`\$\{base\}\/products`, \(\{ sku: "WIDGET-1"/,
    );
    // GET /products/{id} for `api.products.getById(p)` (auto-`.id`).
    expect(e2e).toMatch(/__get\(`\$\{base\}\/products\/\$\{p\.id\}`\)/);
    // POST /orders/{id}/add_line for the operation call with body.
    expect(e2e).toMatch(
      /__post\(`\$\{base\}\/orders\/\$\{ord\.id\}\/add_line`,/,
    );
    // GET /orders/by_customer with the find query name in snake_case.
    expect(e2e).toMatch(
      /__getQuery\(`\$\{base\}\/orders\/by_customer`,/,
    );
  });
});
