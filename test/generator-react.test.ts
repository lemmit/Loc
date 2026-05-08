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

  describe("slice 20 — AppShell.Navbar + NavLink sidebar redesign", () => {
    it("App.tsx mounts AppShell.Navbar with Burger toggle + grouped NavLinks", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      // AppShell carries a navbar config.
      expect(app).toMatch(
        /navbar=\{\{ width: 240, breakpoint: "sm", collapsed: \{ mobile: !opened \} \}\}/,
      );
      // Burger toggle in header.
      expect(app).toMatch(/<Burger\s+opened=\{opened\}/);
      expect(app).toMatch(/data-testid="nav-burger"/);
      // Sidebar Stack uses Mantine NavLinks (not bare Anchors).
      expect(app).toMatch(/<AppShell\.Navbar p="md">/);
      expect(app).toMatch(/data-testid="nav-sidebar"/);
      expect(app).toMatch(/from "@mantine\/core"[\s\S]*?NavLink/);
    });

    it("sidebar groups Aggregates / Workflows / Views with Dividers + active highlighting", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      // Section headers (Mantine Divider with label).
      expect(app).toMatch(
        /<Divider my="xs" label="Aggregates" labelPosition="left" \/>/,
      );
      expect(app).toMatch(
        /<Divider my="xs" label="Workflows" labelPosition="left" \/>/,
      );
      expect(app).toMatch(
        /<Divider my="xs" label="Views" labelPosition="left" \/>/,
      );
      // Per-aggregate NavLink with active prop wired through useLocation.
      expect(app).toMatch(
        /<NavLink component=\{Link\} to="\/orders" label="Orders" active=\{isActive\("\/orders"\)\}/,
      );
      // Index-page NavLinks use exact-match so /workflows doesn't
      // shadow /workflows/<slug>.
      expect(app).toMatch(
        /to="\/workflows" label="All workflows" active=\{isActive\("\/workflows", \{ exact: true \}\)\}/,
      );
      // useLocation + useDisclosure wired up.
      expect(app).toMatch(/import \{ useDisclosure \} from "@mantine\/hooks"/);
      expect(app).toMatch(/useLocation/);
    });

    it("sidebar omits a section when the deployable has no entries of that kind", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      // Single aggregate, no workflows, no views.
      const doc = await helper(`
        system Plain {
          module M {
            context C {
              aggregate Thing { name: string display }
              repository Things for Thing { }
            }
          }
          deployable api { platform: hono, modules: M, port: 3000 }
          deployable web { platform: react, targets: api, port: 3001 }
        }
      `, { validation: true });
      const { files } = generateSystems(doc.parseResult.value as Model);
      const app = files.get("web/src/App.tsx")!;
      expect(app).toMatch(/<Divider my="xs" label="Aggregates"/);
      // No workflows / views section emitted.
      expect(app).not.toMatch(/label="Workflows"/);
      expect(app).not.toMatch(/label="Views"/);
      expect(app).not.toMatch(/data-testid="nav-workflows"/);
      expect(app).not.toMatch(/data-testid="nav-views"/);
    });

    it("detail page uses Breadcrumbs (Home / <Plural> / id) instead of a bare back-anchor", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const detail = files.get("web_app/src/pages/orders/detail.tsx")!;
      expect(detail).toMatch(/<Breadcrumbs data-testid="orders-detail-breadcrumbs">/);
      expect(detail).toMatch(/<Anchor component=\{Link\} to="\/">Home<\/Anchor>/);
      expect(detail).toMatch(/<Anchor component=\{Link\} to="\/orders">Orders<\/Anchor>/);
      // The old "← back" anchor is gone — Breadcrumbs replaces it.
      expect(detail).not.toMatch(/← back/);
    });

    it("list page renders an explicit empty state instead of a zero-row table", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const list = files.get("web_app/src/pages/orders/list.tsx")!;
      // Empty-state branch with a primary call-to-action.
      expect(list).toMatch(/data-testid="orders-list-empty"/);
      expect(list).toMatch(/q\.data && q\.data\.length === 0/);
      expect(list).toMatch(/Create your first order/);
      // Table only renders when there ARE rows; row hover is on.
      expect(list).toMatch(/q\.data && q\.data\.length > 0/);
      expect(list).toMatch(/highlightOnHover/);
    });

    it("home page lands as a summary, not a duplicate of the sidebar", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const home = files.get("web_app/src/pages/home.tsx")!;
      // SimpleGrid of construct-kind summary cards.
      expect(home).toMatch(/<SimpleGrid cols=\{\{ base: 1, sm: 2, md: 3 \}\}/);
      // Counts mention the right cardinalities (acme has 2 aggregates,
      // 1 workflow, 2 views).
      expect(home).toMatch(/2 aggregates/);
      expect(home).toMatch(/1 workflow[^s]/);
      expect(home).toMatch(/2 views/);
      expect(home).toMatch(/data-testid="home"/);
    });
  });

  it("App.tsx wraps Routes in an error boundary and registers a 404 catch-all", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const app = files.get("web_app/src/App.tsx")!;
    // Class component error boundary at the App level.
    expect(app).toMatch(/class AppErrorBoundary extends React\.Component/);
    expect(app).toMatch(/static getDerivedStateFromError/);
    expect(app).toMatch(/<AppErrorBoundary>/);
    // 404 catch-all route after every aggregate route.
    expect(app).toMatch(/function NotFound\(\): JSX\.Element/);
    expect(app).toMatch(/<Route path="\*" element={<NotFound \/>} \/>/);
  });

  describe("slice 19 — design tokens (theme block → Mantine theme)", () => {
    it("emits src/theme.ts with shade ramps + wires MantineProvider when theme is declared", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const theme = files.get("web_app/src/theme.ts")!;
      // 10-shade arrays for each declared color, anchored at index 6.
      expect(theme).toMatch(/const brand: MantineColorsTuple = \[/);
      expect(theme).toMatch(/const neutral: MantineColorsTuple = \[/);
      // The user's primary "#3b82f6" lands at index 6 (the shade
      // Mantine uses for filled primary buttons).  The shade
      // generator is deterministic — pin the exact match.
      expect(theme).toMatch(/"#3b82f6",\s*\n\s*"#0a56d3",/);
      // createTheme config registers the brand + gray, sets
      // primaryColor + defaultRadius + fontFamily.
      expect(theme).toMatch(/primaryColor: "brand"/);
      expect(theme).toMatch(/colors: \{\s*brand,\s*gray: neutral,?\s*\}/);
      expect(theme).toMatch(/defaultRadius: "md"/);
      expect(theme).toMatch(/fontFamily: "Inter, system-ui, sans-serif"/);
      expect(theme).toMatch(/headings: \{ fontFamily: "Inter, system-ui, sans-serif" \}/);

      // main.tsx imports the theme + passes it to MantineProvider.
      const main = files.get("web_app/src/main.tsx")!;
      expect(main).toMatch(/import \{ theme \} from "\.\/theme\.js"/);
      expect(main).toMatch(/<MantineProvider theme=\{theme\}>/);
    });

    it("does NOT emit theme.ts and uses bare MantineProvider when no theme block is declared", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Untheme {
          module M {
            context C {
              aggregate A { name: string display }
              repository As for A { }
            }
          }
          deployable api { platform: dotnet, modules: M, port: 8080 }
          deployable web { platform: react, targets: api, port: 3001 }
        }
      `, { validation: true });
      const model = doc.parseResult.value as Model;
      const { files } = generateSystems(model);
      // No theme.ts emitted.
      expect(files.has("web/src/theme.ts")).toBe(false);
      // main.tsx uses the bare provider (no theme prop, no import).
      const main = files.get("web/src/main.tsx")!;
      expect(main).not.toMatch(/from "\.\/theme\.js"/);
      expect(main).toMatch(/<MantineProvider>/);
    });

    it("validator rejects unknown theme property names", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Bad {
          theme {
            primary: "#ff0000"
            wholeKitchenSink: "#00ff00"
          }
        }
      `, { validation: true });
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(
        errors.some((e) =>
          /unknown theme property 'wholeKitchenSink'/.test(e.message),
        ),
      ).toBe(true);
    });

    it("validator rejects duplicate theme property names", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Bad {
          theme {
            primary: "#ff0000"
            primary: "#00ff00"
          }
        }
      `, { validation: true });
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(
        errors.some((e) => /declared more than once/.test(e.message)),
      ).toBe(true);
    });

    it("validator rejects non-hex color values", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Bad {
          theme {
            primary: "blue"
          }
        }
      `, { validation: true });
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(
        errors.some((e) =>
          /must be a CSS hex color/.test(e.message),
        ),
      ).toBe(true);
    });

    it("validator rejects radius values outside the enum", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Bad {
          theme {
            radius: "huge"
          }
        }
      `, { validation: true });
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(
        errors.some((e) =>
          /must be one of none \| sm \| md \| lg \| xl/.test(e.message),
        ),
      ).toBe(true);
    });

    it("validator rejects more than one theme block per system", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Bad {
          theme { primary: "#ff0000" }
          theme { primary: "#00ff00" }
        }
      `, { validation: true });
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(
        errors.some((e) => /more than one 'theme \{ \.\.\. \}' block/.test(e.message)),
      ).toBe(true);
    });
  });

  describe("slice 18.A — workflow form pages", () => {
    it("emits an api/workflows.ts module with one Zod schema + mutation hook per workflow", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const api = files.get("web_app/src/api/workflows.ts")!;
      // Per-workflow request schema + inferred type.
      expect(api).toMatch(/export const PlaceOrderRequest = z\.object\(\{/);
      expect(api).toMatch(/customerId: z\.string\(\)/);
      expect(api).toMatch(/productId: z\.string\(\)/);
      expect(api).toMatch(/quantity: z\.number\(\)\.int\(\)/);
      expect(api).toMatch(
        /export type PlaceOrderRequest = z\.infer<typeof PlaceOrderRequest>/,
      );
      // Mutation hook posts to the backend's /workflows/<slug> route.
      expect(api).toMatch(/export function usePlaceOrderWorkflow\(\)/);
      expect(api).toMatch(/api\.post\(`\/workflows\/place_order`, input\)/);
    });

    it("emits a workflows index page listing every workflow", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const idx = files.get("web_app/src/pages/workflows/index.tsx")!;
      // One card per workflow, with a Run link.
      expect(idx).toMatch(/data-testid="workflow-card-place_order"/);
      // Humanised title.
      expect(idx).toMatch(/<Title order=\{4\}>Place Order<\/Title>/);
      // Parameter signature surfaces in a dimmed text row.  The
      // type label is emitted as a string literal so JSX doesn't
      // parse `Id<Product>` as an opening element.
      expect(idx).toMatch(
        /workflow-place_order-param-customerId.*<strong>customerId<\/strong>: \{"string"\}/,
      );
      expect(idx).toMatch(
        /workflow-place_order-param-productId.*<strong>productId<\/strong>: \{"Id<Product>"\}/,
      );
      // "Run" button links to the per-workflow page.
      expect(idx).toMatch(/to="\/workflows\/place_order"/);
    });

    it("emits a per-workflow form page with typed inputs reusing the v4 form helpers", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const page = files.get("web_app/src/pages/workflows/place_order.tsx")!;
      // RHF + zodResolver wiring matches the aggregate-operation pattern.
      expect(page).toMatch(/import \{ useForm, Controller \} from "react-hook-form"/);
      expect(page).toMatch(/zodResolver\(PlaceOrderRequest\)/);
      expect(page).toMatch(/usePlaceOrderWorkflow/);
      // String param → TextInput; Id<X> → Select with target's display field;
      // int → NumberInput with allowDecimal={false}.
      expect(page).toMatch(/<TextInput label="customerId"/);
      expect(page).toMatch(
        /<Select label="productId"[\s\S]+?__products\.data/,
      );
      expect(page).toMatch(/<NumberInput label="quantity"[\s\S]+?allowDecimal=\{false\}/);
      // useAllProducts pulled in for the Id<Product> Select.
      expect(page).toMatch(
        /import \{ useAllProducts \} from "\.\.\/\.\.\/api\/product\.js"/,
      );
      // Submit button + success/error toast.
      expect(page).toMatch(/data-testid="workflow-place_order-submit"/);
      expect(page).toMatch(/notifications\.show\(\{ color: "green", message: "Place Order completed" \}\)/);
      // After success navigate back to the index.
      expect(page).toMatch(/navigate\("\/workflows"\)/);
    });

    it("App.tsx registers /workflows + /workflows/<slug> routes and sidebar entry", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      // Index + per-workflow imports.
      expect(app).toMatch(
        /import WorkflowsIndex from "\.\/pages\/workflows\/index\.js"/,
      );
      expect(app).toMatch(
        /import PlaceOrderWorkflowPage from "\.\/pages\/workflows\/place_order\.js"/,
      );
      // Routes — index + per-workflow.
      expect(app).toMatch(
        /<Route path="\/workflows" element=\{<WorkflowsIndex \/>\} \/>/,
      );
      expect(app).toMatch(
        /<Route path="\/workflows\/place_order" element=\{<PlaceOrderWorkflowPage \/>\} \/>/,
      );
      // Sidebar entry — "All workflows" parent NavLink + one
      // NavLink per workflow (slice 20 navbar redesign).
      expect(app).toMatch(
        /<NavLink component=\{Link\} to="\/workflows" label="All workflows"[\s\S]*?data-testid="nav-workflows"/,
      );
      expect(app).toMatch(
        /<NavLink component=\{Link\} to="\/workflows\/place_order" label="Place Order"[\s\S]*?data-testid="nav-workflow-place_order"/,
      );
    });

    it("home page summarises workflows when at least one exists", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const home = files.get("web_app/src/pages/home.tsx")!;
      // Slice 20 simplified the home page: a card per construct
      // kind with a count + "Open <kind>" link, instead of a full
      // navigation re-listing.
      expect(home).toMatch(/1 workflow[^s]/);
      expect(home).toMatch(/data-testid="home-workflows-link"/);
    });
  });

  describe("slice 18.B — view list pages", () => {
    it("emits an api/views.ts module with a query hook per view", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const api = files.get("web_app/src/api/views.ts")!;
      // Shorthand view reuses the source aggregate's list response.
      expect(api).toMatch(
        /export const ActiveOrdersResponse = OrderListResponse;/,
      );
      expect(api).toMatch(/export function useActiveOrdersView\(\)/);
      expect(api).toMatch(/api\.get\(`\/views\/active_orders`\)/);
      // Full-form view emits its own row + array schemas.
      expect(api).toMatch(/export const OrderSummaryRow = z\.object\(\{/);
      expect(api).toMatch(/orderId: z\.string\(\)/);
      expect(api).toMatch(/status: OrderStatusSchema/);
      expect(api).toMatch(/lineCount: z\.number\(\)\.int\(\)/);
      expect(api).toMatch(
        /export const OrderSummaryResponse = z\.array\(OrderSummaryRow\);/,
      );
      expect(api).toMatch(/export function useOrderSummaryView\(\)/);
    });

    it("emits a views index page listing every view", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const idx = files.get("web_app/src/pages/views/index.tsx")!;
      expect(idx).toMatch(/data-testid="view-card-active_orders"/);
      expect(idx).toMatch(/data-testid="view-card-order_summary"/);
      expect(idx).toMatch(/<Title order=\{4\}>Active Orders<\/Title>/);
      expect(idx).toMatch(/<Title order=\{4\}>Order Summary<\/Title>/);
      // Shorthand view shows the source aggregate; full-form view
      // shows "Custom shape: <field names>".
      expect(idx).toMatch(/Source: Order/);
      expect(idx).toMatch(/Custom shape: orderId, status, lineCount/);
    });

    it("emits a per-view table page that calls the query hook", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const page = files.get("web_app/src/pages/views/order_summary.tsx")!;
      expect(page).toMatch(/import \{ useOrderSummaryView \} from "\.\.\/\.\.\/api\/views\.js"/);
      expect(page).toMatch(/const q = useOrderSummaryView\(\)/);
      // Table headers from the view's declared fields.
      expect(page).toMatch(/<Table\.Th>orderId<\/Table\.Th>/);
      expect(page).toMatch(/<Table\.Th>status<\/Table\.Th>/);
      expect(page).toMatch(/<Table\.Th>lineCount<\/Table\.Th>/);
      // Id<Order> cell auto-links to /orders/<id> (Order has UI in
      // this deployable's modules).
      expect(page).toMatch(
        /<Anchor component=\{Link\} to=\{`\/orders\/\$\{row\.orderId\}`\}/,
      );
      // Empty + error states present.
      expect(page).toMatch(/q\.data && q\.data\.length === 0 && <Text c="dimmed">No rows\.<\/Text>/);
      expect(page).toMatch(/q\.isError && <Alert color="red">/);
    });

    it("shorthand view's table page uses the source aggregate's wire columns", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const page = files.get("web_app/src/pages/views/active_orders.tsx")!;
      // ActiveOrders is shorthand `view ActiveOrders = Order where ...`
      // — table columns mirror Order's primitive/id/enum fields.
      expect(page).toMatch(/<Table\.Th>id<\/Table\.Th>/);
      expect(page).toMatch(/<Table\.Th>customerId<\/Table\.Th>/);
      expect(page).toMatch(/<Table\.Th>status<\/Table\.Th>/);
      expect(page).toMatch(/<Table\.Th>placedAt<\/Table\.Th>/);
    });

    it("App.tsx registers /views + /views/<slug> routes and sidebar entry", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      expect(app).toMatch(
        /import ViewsIndex from "\.\/pages\/views\/index\.js"/,
      );
      expect(app).toMatch(
        /import ActiveOrdersViewPage from "\.\/pages\/views\/active_orders\.js"/,
      );
      expect(app).toMatch(
        /import OrderSummaryViewPage from "\.\/pages\/views\/order_summary\.js"/,
      );
      expect(app).toMatch(
        /<Route path="\/views" element=\{<ViewsIndex \/>\} \/>/,
      );
      expect(app).toMatch(
        /<Route path="\/views\/active_orders" element=\{<ActiveOrdersViewPage \/>\} \/>/,
      );
      expect(app).toMatch(
        /<NavLink component=\{Link\} to="\/views" label="All views"[\s\S]*?data-testid="nav-views"/,
      );
      expect(app).toMatch(
        /<NavLink component=\{Link\} to="\/views\/active_orders" label="Active Orders"[\s\S]*?data-testid="nav-view-active_orders"/,
      );
    });

    it("home page summarises views when at least one exists", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const home = files.get("web_app/src/pages/home.tsx")!;
      expect(home).toMatch(/2 views/);
      expect(home).toMatch(/data-testid="home-views-link"/);
    });
  });

  describe("slice 18.C — DSL e2e for ui.workflows.* + ui.views.*", () => {
    it("emits a Playwright page object per workflow", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const po = files.get("web_app/e2e/pages/workflows/place_order.ts")!;
      expect(po).toMatch(/export class PlaceOrderWorkflowPage/);
      // Typed `fill` accepting Partial<PlaceOrderRequest>.
      expect(po).toMatch(
        /async fill\(input: Partial<PlaceOrderRequest>\): Promise<this>/,
      );
      // Drives inputs via the same testid prefix the form page uses.
      expect(po).toMatch(/workflow-place_order-input-customerId/);
      expect(po).toMatch(/workflow-place_order-input-productId/);
      expect(po).toMatch(/workflow-place_order-input-quantity/);
      // Submit waits for navigation back to /workflows.
      expect(po).toMatch(/this\.page\.waitForURL\(\/\\\/workflows\$\/\)/);
      // Convenience `run` wraps goto + fill + submit.
      expect(po).toMatch(/async run\(input: PlaceOrderRequest\): Promise<void>/);
    });

    it("emits a Playwright page object per view", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const po = files.get("web_app/e2e/pages/views/order_summary.ts")!;
      expect(po).toMatch(/export class OrderSummaryViewPage/);
      // Row shape interface declared locally — keeps the page object
      // self-contained.
      expect(po).toMatch(/export interface OrderSummaryRowText \{/);
      expect(po).toMatch(/orderId: string;/);
      expect(po).toMatch(/lineCount: string;/);
      // rows() walks indexed testids until break.
      expect(po).toMatch(
        /async rows\(\): Promise<OrderSummaryRowText\[\]>/,
      );
      expect(po).toMatch(/view-order_summary-row-\$\{i\}-orderId/);
    });

    it("UI spec lowers ui.workflows.<name>(...) to the generated page object's run()", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const ui = files.get("web_app/e2e/Acme.ui.spec.ts")!;
      // Page-object import.
      expect(ui).toMatch(
        /import \{ PlaceOrderWorkflowPage \} from "\.\/pages\/workflows\/place_order\.js"/,
      );
      // The workflow call lowers to `await new <Cap>WorkflowPage(page).run({...})`.
      expect(ui).toMatch(
        /await new PlaceOrderWorkflowPage\(page\)\.run\(/,
      );
    });

    it("UI spec lowers ui.views.<name>() to the generated page object's rows()", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const ui = files.get("web_app/e2e/Acme.ui.spec.ts")!;
      expect(ui).toMatch(
        /import \{ ActiveOrdersViewPage \} from "\.\/pages\/views\/active_orders\.js"/,
      );
      // The view call lowers to a goto + rows() pair, wrapped so the
      // let-binding resolves to the array (not a Promise).
      expect(ui).toMatch(
        /new ActiveOrdersViewPage\(page\)\.goto\(\)/,
      );
      expect(ui).toMatch(/await __view\.rows\(\)/);
    });

    it("validator rejects ui.workflows.<unknown>", async () => {
      const { parseHelper } = await import("langium/test");
      const { lowerModel } = await import("../src/ir/lower.js");
      const { enrichLoomModel } = await import("../src/ir/enrichments.js");
      const { validateLoomModel } = await import("../src/ir/validate.js");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Demo {
          module M {
            context C {
              aggregate A { name: string display }
              repository As for A { }
            }
          }
          deployable api { platform: dotnet, modules: M, port: 8080 }
          deployable web { platform: react, targets: api, port: 3001 }
          test e2e "bad" against web {
            ui.workflows.doesNotExist({})
          }
        }
      `, { validation: true });
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const diags = validateLoomModel(loom);
      expect(
        diags.some(
          (d) =>
            d.severity === "error" &&
            /unknown workflow 'ui\.workflows\.doesNotExist'/.test(d.message),
        ),
      ).toBe(true);
    });

    it("validator rejects ui.views.<unknown>", async () => {
      const { parseHelper } = await import("langium/test");
      const { lowerModel } = await import("../src/ir/lower.js");
      const { enrichLoomModel } = await import("../src/ir/enrichments.js");
      const { validateLoomModel } = await import("../src/ir/validate.js");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(`
        system Demo {
          module M {
            context C {
              aggregate A { name: string display }
              repository As for A { }
            }
          }
          deployable api { platform: dotnet, modules: M, port: 8080 }
          deployable web { platform: react, targets: api, port: 3001 }
          test e2e "bad" against web {
            let r = ui.views.doesNotExist()
          }
        }
      `, { validation: true });
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const diags = validateLoomModel(loom);
      expect(
        diags.some(
          (d) =>
            d.severity === "error" &&
            /unknown view 'ui\.views\.doesNotExist'/.test(d.message),
        ),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Slice 21.A — wire-boundary validation on the React side.
  // -------------------------------------------------------------------
  describe("invariants on the wire (slice 21.A — React Zod refines)", () => {
    it("absorbs single-field VO invariants into idiomatic native chains on <VO>Schema", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const productApi = files.get("web_app/src/api/product.ts")!;
      // acme Money: invariant amount >= 0 + invariant currency.length == 3
      expect(productApi).toMatch(/amount: z\.number\(\)\.min\(0\)/);
      expect(productApi).toMatch(/currency: z\.string\(\)\.length\(3\)/);
      // No leftover refine on MoneySchema.
      const moneyBlock = productApi.match(
        /export const MoneySchema = z\.object\(\{[\s\S]*?\}\)([^;]*);/,
      )!;
      expect(moneyBlock[1]).toBe("");
    });

    it("absorbs single-field aggregate invariants into native chains on Create<Agg>Request", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const productApi = files.get("web_app/src/api/product.ts")!;
      // acme Product has `invariant sku.length > 0` — recognised as min(1).
      expect(productApi).toMatch(
        /CreateProductRequest = z\.object\(\{[\s\S]*sku: z\.string\(\)\.min\(1\)/,
      );
      const createBlock = productApi.match(
        /export const CreateProductRequest = z\.object\(\{[\s\S]*?\}\)([^;]*);/,
      )!;
      // Single-field rule absorbed into chain → no .refine().
      expect(createBlock[1]).toBe("");
    });

    it("absorbs single-field op-precondition into native chain on <Op>Request", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const orderApi = files.get("web_app/src/api/order.ts")!;
      // acme Order.addLine: precondition qty > 0 (int qty).
      expect(orderApi).toMatch(
        /AddLineRequest = z\.object\(\{[\s\S]*qty: z\.number\(\)\.int\(\)\.min\(1\)/,
      );
    });

    it("excludes invariants referencing aggregate state (containment / helper-fn / state) from wire schemas", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const orderApi = files.get("web_app/src/api/order.ts")!;
      // CreateOrderRequest carries customerId + status + placedAt.
      // Order.invariants reference `lines.count` (containment, not in body).
      // The classifier correctly skips it; schema has no .refine().
      const createBlock = orderApi.match(
        /export const CreateOrderRequest = z\.object\(\{[\s\S]*?\}\)([^;]*);/,
      )!;
      expect(createBlock[1]).toBe("");
      // ConfirmRequest is empty: `isMutable()` + `lines.count > 0`
      // are both non-translatable → no params, no refines.
      expect(orderApi).toMatch(
        /export const ConfirmRequest = z\.object\(\{\s*\}\);/,
      );
    });

    it("RHF still binds zodResolver to the refined CreateProductRequest schema", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const newProduct = files.get("web_app/src/pages/products/new.tsx")!;
      // Existing slice 17 contract — refines compose into the same
      // schema name, so the form keeps working.
      expect(newProduct).toMatch(/zodResolver\(CreateProductRequest\)/);
    });
  });
});
