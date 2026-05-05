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
    expect(pkg.dependencies["react-hook-form"]).toBeTruthy();
    expect(pkg.dependencies["@hookform/resolvers"]).toBeTruthy();
    expect(pkg.dependencies["@mantine/form"]).toBeFalsy();
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

  it("react-hook-form wires to mutations and surfaces notifications", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const newOrder = files.get("web_app/src/pages/orders/new.tsx")!;
    expect(newOrder).toMatch(/from "react-hook-form"/);
    expect(newOrder).toMatch(/from "@hookform\/resolvers\/zod"/);
    expect(newOrder).toMatch(/zodResolver\(CreateOrderRequest\)/);
    expect(newOrder).toMatch(/notifications\.show/);
    expect(newOrder).toMatch(/useCreateOrder/);
    // Phase 1: no @mantine/form / mantine-form-zod-resolver, no `as never` cast.
    expect(newOrder).not.toMatch(/@mantine\/form/);
    expect(newOrder).not.toMatch(/mantine-form-zod-resolver/);
    expect(newOrder).not.toMatch(/as never/);
  });

  it("Phase 2: datetime fields use native input with second precision", async () => {
    // Phase 2 originally swapped to Mantine's <DateTimePicker> via
    // Controller, but Mantine's picker renders as a button (not a
    // typeable input) and resists Playwright's `.fill()` even with
    // valueFormat pinned.  Walked back to native datetime-local; we
    // keep seconds (slice 0..19, not 0..16) and document the
    // UTC-implicit timezone assumption.
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const newOrder = files.get("web_app/src/pages/orders/new.tsx")!;
    expect(newOrder).toMatch(/<TextInput label="placedAt"[^>]*type="datetime-local"/);
    expect(newOrder).not.toMatch(/DateTimePicker/);
    expect(newOrder).not.toMatch(/@mantine\/dates/);
    const orderPo = files.get("web_app/e2e/pages/order.ts")!;
    // Page object preserves seconds.  No helpers file required.
    expect(orderPo).toMatch(/\.slice\(0, 19\)/);
    expect(orderPo).not.toMatch(/\.slice\(0, 16\)/);
    expect(orderPo).not.toMatch(/formatPickerValue/);
    expect(files.get("web_app/e2e/pages/_helpers.ts")).toBeFalsy();
  });

  it("Phase 3: Id<X> op-param renders Select populated by useAll<X>()", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const detail = files.get("web_app/src/pages/orders/detail.tsx")!;
    // Cross-aggregate hook import.
    expect(detail).toMatch(
      /import \{ useAllProducts \} from "\.\.\/\.\.\/api\/product\.js"/,
    );
    // Hook called inside the operation form component.
    expect(detail).toMatch(/const __products = useAllProducts\(\);/);
    // Select bound by Controller, populated from the hook's data,
    // labelled by the target's display field (`sku`).
    expect(detail).toMatch(/<Select label="productId"/);
    expect(detail).toMatch(/__products\.data \?\? \[\]/);
    expect(detail).toMatch(/label: __o\.sku/);
    // renderOption emits a per-option testid for Playwright drivers.
    expect(detail).toMatch(/data-testid=\{`orders-op-addLine-input-productId-option-\$\{option\.value\}`\}/);
    // Old plain-TextInput placeholder is gone.
    expect(detail).not.toMatch(/placeholder="<id>"/);
  });

  it("Phase 3: page object clicks the testid'd option for Id<X> params", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const orderPo = files.get("web_app/e2e/pages/order.ts")!;
    expect(orderPo).toMatch(
      /getByTestId\(`orders-op-addLine-input-productId-option-\$\{input\.productId!\}`\)/,
    );
    // Old `.fill()` against the input is gone for Id<X> fields.
    expect(orderPo).not.toMatch(
      /getByTestId\("orders-op-addLine-input-productId"\)\.fill/,
    );
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

  it("sprinkles stable data-testid attributes on every interactive element", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const list = files.get("web_app/src/pages/orders/list.tsx")!;
    const newPage = files.get("web_app/src/pages/orders/new.tsx")!;
    const detail = files.get("web_app/src/pages/orders/detail.tsx")!;
    expect(list).toMatch(/data-testid="orders-list-create"/);
    expect(list).toMatch(/data-testid=\{`orders-row-\$\{row\.id\}`\}/);
    expect(newPage).toMatch(/data-testid="orders-new-input-customerId"/);
    expect(newPage).toMatch(/data-testid="orders-new-submit"/);
    expect(detail).toMatch(/data-testid="orders-detail-status"/);
    expect(detail).toMatch(/data-testid="orders-op-confirm"/);
    expect(detail).toMatch(/data-testid="orders-op-confirm-submit"/);
    expect(detail).toMatch(/data-testid="orders-op-addLine-input-productId"/);
  });

  it("emits Playwright page-object classes per aggregate under e2e/pages/", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const orderPo = files.get("web_app/e2e/pages/order.ts")!;
    expect(orderPo).toMatch(/from "@playwright\/test"/);
    expect(orderPo).toMatch(/export class OrderListPage/);
    expect(orderPo).toMatch(/export class OrderNewPage/);
    expect(orderPo).toMatch(/export class OrderDetailPage/);
    // Typed input contract.
    expect(orderPo).toMatch(/Partial<CreateOrderRequest>/);
    expect(orderPo).toMatch(/AddLineRequest/);
    // One method per public op.
    expect(orderPo).toMatch(/async addLine\(input: AddLineRequest\)/);
    expect(orderPo).toMatch(/async confirm\(\): Promise<this>/);
    // Master-detail helper for the contained collection.
    expect(orderPo).toMatch(/async linesCount\(\): Promise<number>/);
    // Field reader is typed off the response shape.
    expect(orderPo).toMatch(/field<K extends keyof OrderResponse>/);
  });

  it("emits playwright.config.ts and a smoke spec under e2e/", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const config = files.get("web_app/e2e/playwright.config.ts")!;
    expect(config).toMatch(/E2E_BASE_URL/);
    expect(config).toMatch(/http:\/\/localhost:3001/);
    const smoke = files.get("web_app/e2e/smoke.spec.ts")!;
    expect(smoke).toMatch(/orders list loads/);
    expect(smoke).toMatch(/products list loads/);
    // e2e package.json is independent so the runtime image stays slim.
    const e2ePkg = JSON.parse(files.get("web_app/e2e/package.json")!);
    expect(e2ePkg.devDependencies["@playwright/test"]).toBeTruthy();
    const webPkg = JSON.parse(files.get("web_app/package.json")!);
    expect(webPkg.devDependencies["@playwright/test"]).toBeUndefined();
  });

  it("emits a certs/ directory + Dockerfile that copies it (proxy-CA escape hatch)", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    expect(files.has("web_app/certs/.gitkeep")).toBe(true);
    expect(files.has("api/certs/.gitkeep")).toBe(true);
    expect(files.has("catalog_web/certs/.gitkeep")).toBe(true);
    const reactDocker = files.get("web_app/Dockerfile")!;
    expect(reactDocker).toMatch(/COPY certs\//);
    const dotnetDocker = files.get("api/Dockerfile")!;
    expect(dotnetDocker).toMatch(/COPY certs\//);
    const honoDocker = files.get("catalog_web/Dockerfile")!;
    expect(honoDocker).toMatch(/COPY certs\//);
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
