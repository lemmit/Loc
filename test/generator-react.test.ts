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

describe("react generator", () => {
  it("emits a Vite + React + RQ + Zod + Mantine shell for a react deployable", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const keys = [...files.keys()];

    // Project shell.
    expect(keys).toContain("web_app/package.json");
    expect(keys).toContain("web_app/vite.config.ts");
    expect(keys).toContain("web_app/index.html");
    expect(keys).toContain("web_app/Dockerfile");
    expect(keys).toContain("web_app/.dockerignore");
    expect(keys).toContain("web_app/src/main.tsx");
    expect(keys).toContain("web_app/src/App.tsx");
    expect(keys).toContain("web_app/src/api/client.ts");
    expect(keys).toContain("web_app/src/api/config.ts");

    // Deps include the libraries the generator hooks against.
    const pkg = JSON.parse(files.get("web_app/package.json")!);
    expect(pkg.dependencies["react"]).toBeTruthy();
    expect(pkg.dependencies["@tanstack/react-query"]).toBeTruthy();
    expect(pkg.dependencies["@mantine/core"]).toBeTruthy();
    expect(pkg.dependencies["zod"]).toBeTruthy();
    expect(pkg.dependencies["mantine-form-zod-resolver"]).toBeTruthy();
  });

  it("inherits the target's modules, so pages cover both Catalog and Sales", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const keys = [...files.keys()];
    // From Catalog.
    expect(keys).toContain("web_app/src/api/product.ts");
    expect(keys).toContain("web_app/src/pages/products/list.tsx");
    expect(keys).toContain("web_app/src/pages/products/detail.tsx");
    expect(keys).toContain("web_app/src/pages/products/new.tsx");
    // From Sales (transitively, since `api` includes both modules).
    expect(keys).toContain("web_app/src/api/order.ts");
    expect(keys).toContain("web_app/src/pages/orders/list.tsx");
  });

  it("emits typed React Query hooks per HTTP route", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const orderApi = files.get("web_app/src/api/order.ts")!;
    expect(orderApi).toMatch(/export function useAllOrders/);
    expect(orderApi).toMatch(/export function useOrderById/);
    expect(orderApi).toMatch(/export function useCreateOrder/);
    // One hook per public DSL operation.
    expect(orderApi).toMatch(/export function useAddLineOrder/);
    expect(orderApi).toMatch(/export function useConfirmOrder/);
    // Per-find hook (non-`all`).
    expect(orderApi).toMatch(/export function useByCustomerOrder/);
  });

  it("Zod schemas mirror the wire shape — request + response", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const orderApi = files.get("web_app/src/api/order.ts")!;
    expect(orderApi).toMatch(/CreateOrderRequest = z\.object/);
    expect(orderApi).toMatch(/OrderResponse = z\.object/);
    expect(orderApi).toMatch(/customerId: z\.string\(\)/);
    expect(orderApi).toMatch(/lines: z\.array\(OrderLineResponse\)/);
    expect(orderApi).toMatch(/OrderListResponse = z\.array\(OrderResponse\)/);
  });

  it("Mantine forms wire to mutations and surface notifications", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const newOrder = files.get("web_app/src/pages/orders/new.tsx")!;
    expect(newOrder).toMatch(/from "@mantine\/form"/);
    expect(newOrder).toMatch(/from "mantine-form-zod-resolver"/);
    expect(newOrder).toMatch(/zodResolver\(CreateOrderRequest\)/);
    expect(newOrder).toMatch(/notifications\.show/);
    expect(newOrder).toMatch(/useCreateOrder/);
  });

  it("detail page shows fields + nested parts (master-detail) + operation buttons", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const detail = files.get("web_app/src/pages/orders/detail.tsx")!;
    expect(detail).toMatch(/use OrderById/.source.replace(/\s/g, ""));
    // Nested-part rendering (lines is a contained collection).
    expect(detail).toMatch(/data\.lines\.map/);
    // Operation buttons + their modal forms.
    expect(detail).toMatch(/openAddLineModal/);
    expect(detail).toMatch(/openConfirmModal/);
  });

  it("API base URL is baked from the target deployable's port", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const config = files.get("web_app/src/api/config.ts")!;
    // `webApp` targets `api` which is on port 8080.
    expect(config).toMatch(/http:\/\/localhost:8080/);
  });

  it("docker-compose service has VITE_API_BASE_URL and no DB connection", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const compose = files.get("docker-compose.yml")!;
    expect(compose).toMatch(/web_app:\s*\n\s*build: \.\/web_app/);
    expect(compose).toMatch(/VITE_API_BASE_URL/);
    // The webApp section should not declare a DATABASE_URL or
    // ConnectionStrings__Default.
    const webAppBlock =
      compose.match(/web_app:[\s\S]*?(?=\n\s*\w[\w_]*:|$)/)![0];
    expect(webAppBlock).not.toMatch(/DATABASE_URL/);
    expect(webAppBlock).not.toMatch(/ConnectionStrings__Default/);
    // No CREATE DATABASE for the frontend.
    const dbInit = files.get("db-init/00-create-databases.sql")!;
    expect(dbInit).not.toMatch(/CREATE DATABASE web_app/);
  });
});
