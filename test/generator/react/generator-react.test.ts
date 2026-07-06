import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { prepareAppShellVM } from "../../../src/generator/react/templating/preparers/app-shell.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
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
    expect(pkg.dependencies.react).toBeTruthy();
    expect(pkg.dependencies["@tanstack/react-query"]).toBeTruthy();
    expect(pkg.dependencies["@mantine/core"]).toBeTruthy();
    expect(pkg.dependencies.zod).toBeTruthy();
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
    // No @mantine/form / mantine-form-zod-resolver, no `as never` cast.
    expect(newOrder).not.toMatch(/@mantine\/form/);
    expect(newOrder).not.toMatch(/mantine-form-zod-resolver/);
    expect(newOrder).not.toMatch(/as never/);
  });

  it("datetime fields use native input at minute precision (datetime-local without step)", async () => {
    // This originally swapped to Mantine's <DateTimePicker> via
    // Controller, but Mantine's picker renders as a button (not a
    // typeable input) and resists Playwright's `.fill()` even with
    // valueFormat pinned.  Walked back to native datetime-local.
    //
    // A `<input type="datetime-local">` with no `step` is
    // MINUTE-precision: Chromium rejects a value carrying seconds
    // (`YYYY-MM-DDTHH:mm:ss`) as "Malformed value", so the page object
    // must fill 16 chars (`YYYY-MM-DDTHH:mm`), NOT 19.  The headless UI
    // behavioral tier (test/behavioral/run-ui.mjs) caught the 19-char
    // fill hanging the real browser; the backend accepts the
    // minute-precision value (UTC-implicit), so the round-trip stays
    // correct.
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const newOrder = files.get("web_app/src/pages/orders/new.tsx")!;
    expect(newOrder).toMatch(/<TextInput label="Placed At"[^>]*type="datetime-local"/);
    expect(newOrder).not.toMatch(/DateTimePicker/);
    expect(newOrder).not.toMatch(/@mantine\/dates/);
    const orderPo = files.get("web_app/e2e/pages/order.ts")!;
    // Page object fills minute precision (the input's accepted format).
    expect(orderPo).toMatch(/\.slice\(0, 16\)/);
    expect(orderPo).not.toMatch(/\.slice\(0, 19\)/);
    expect(orderPo).not.toMatch(/formatPickerValue/);
    expect(files.get("web_app/e2e/pages/_helpers.ts")).toBeFalsy();
  });

  it("page object clicks the testid'd option for X id params", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const orderPo = files.get("web_app/e2e/pages/order.ts")!;
    expect(orderPo).toMatch(
      /getByTestId\(`orders-op-addLine-input-productId-option-\$\{input\.productId!\}`\)/,
    );
    // Old `.fill()` against the input is gone for X id fields.
    expect(orderPo).not.toMatch(/getByTestId\("orders-op-addLine-input-productId"\)\.fill/);
  });

  it("bakes the relative /api base and proxies it to the target port in dev", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const config = files.get("web_app/src/api/config.ts")!;
    // Same-origin relative base; docker-compose overrides via env, and
    // `vite dev` proxies it to the backend (so no CORS in local dev).
    expect(config).toMatch(/"\/api"/);
    // `webApp` targets `api` on port 8080 — the proxy points there, but the
    // target is env-overridable (VITE_API_PROXY_TARGET) so `vite preview` in
    // compose can retarget the backend SERVICE.  BOTH `server` (vite dev) and
    // `preview` (the compose runtime) proxy `/api` — preview is the one that
    // was previously missing, breaking same-origin under docker compose.
    const vite = files.get("web_app/vite.config.ts")!;
    expect(vite).toContain('VITE_API_PROXY_TARGET ?? "http://localhost:8080"');
    expect(vite.match(/proxy: \{ "\/api":/g)?.length).toBe(2);
    expect(vite).toMatch(/server: \{.*proxy:/);
    expect(vite).toMatch(/preview: \{.*proxy:/);
  });

  it("value-object fieldsets render as filled-variant grouped sub-forms", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    // Product.unitPrice is a Money value object — `new` form wraps
    // its inputs in a styled <Fieldset variant="filled" radius="md">.
    const productNew = files.get("web_app/src/pages/products/new.tsx")!;
    expect(productNew).toMatch(
      /<Fieldset legend="Price" variant="filled" radius="md" data-testid="products-new-input-price">/,
    );
    // Children render inside a <Stack gap="sm">.
    expect(productNew).toMatch(/<Stack gap="sm">/);
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
    expect(orderPo).toMatch(/AddLineOrderRequest/);
    // One method per public op.
    expect(orderPo).toMatch(/async addLine\(input: AddLineOrderRequest\)/);
    expect(orderPo).toMatch(/async confirm\(\): Promise<this>/);
    // Locator helper for the contained collection's rows (assert via
    // toHaveCount).
    expect(orderPo).toMatch(/linesRows\(\): Locator/);
    // Field accessor returns a Locator (web-first assertions), typed off
    // the response shape.
    expect(orderPo).toMatch(/field<K extends keyof OrderResponse>\(name: K\): Locator/);
  });

  it("emits playwright.config.ts and a smoke spec under e2e/", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const config = files.get("web_app/e2e/playwright.config.ts")!;
    expect(config).toMatch(/E2E_BASE_URL/);
    expect(config).toMatch(/http:\/\/localhost:3001/);
    const smoke = files.get("web_app/e2e/smoke.spec.ts")!;
    // Smoke navigates by ROUTE per param-less page (no page-object imports
    // — those broke on uis with custom/partial pages, see smokeSpec).
    expect(smoke).toMatch(/OrderList loads/);
    expect(smoke).toMatch(/ProductList loads/);
    expect(smoke).toMatch(/await page\.goto\("\/orders"\)/);
    expect(smoke).toMatch(/await page\.goto\("\/products"\)/);
    // Parameterised detail pages (`/orders/:id`) are excluded from the smoke.
    expect(smoke).not.toMatch(/:id/);
    // No coupling to e2e/pages/* — the old shape imported <Agg>ListPage.
    expect(smoke).not.toMatch(/from "\.\/pages\//);
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
    // Same-origin: compose points the preview proxy at the backend SERVICE
    // (compose-network host, not localhost), so the bundle's relative `/api`
    // reaches it through `vite preview`.  Only the web_app service carries it.
    expect(compose).toMatch(/VITE_API_PROXY_TARGET: "http:\/\/\w[\w-]*:\d+"/);
    const webAppBlock = compose.match(/web_app:[\s\S]*?(?=\n\s*\w[\w_]*:|$)/)![0];
    expect(webAppBlock).not.toMatch(/DATABASE_URL/);
    expect(webAppBlock).not.toMatch(/ConnectionStrings__Default/);
    // No CREATE DATABASE for the frontend.
    const dbInit = files.get("db-init/00-create-databases.sql")!;
    expect(dbInit).not.toMatch(/CREATE DATABASE web_app/);
  });

  describe("AppShell.Navbar + NavLink sidebar redesign", () => {
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
      // Sidebar Stack uses Mantine NavLinks (not bare Anchors); the
      // navbar carries an accessible name so the <nav> landmark is
      // distinguishable (accessibility.md Phase 2).
      expect(app).toMatch(/<AppShell\.Navbar p="md" aria-label="Primary navigation">/);
      expect(app).toMatch(/data-testid="nav-sidebar"/);
      expect(app).toMatch(/from "@mantine\/core"[\s\S]*?NavLink/);
    });

    // accessibility.md Phase 2 — bypass-blocks skip link + named landmarks.
    it("App.tsx emits a skip link targeting the <main> landmark", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      // Skip link is present and points at the main-content anchor.
      expect(app).toMatch(
        /<a href="#main-content" className="loom-skip-link">Skip to content<\/a>/,
      );
      // The <main> region carries the matching id (AppShell.Main renders <main>).
      expect(app).toMatch(/<AppShell\.Main id="main-content">/);
      // Focus-reveal style for the otherwise-offscreen link.
      expect(app).toMatch(/\.loom-skip-link:focus/);
    });

    it("sidebar groups Aggregates / Workflows / Views with Dividers + active highlighting", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      // Section headers (Mantine Divider with label).
      expect(app).toMatch(/<Divider my="xs" label="Aggregates" labelPosition="left" \/>/);
      expect(app).toMatch(/<Divider my="xs" label="Workflows" labelPosition="left" \/>/);
      expect(app).toMatch(/<Divider my="xs" label="Views" labelPosition="left" \/>/);
      // Per-aggregate NavLink with active prop wired through useLocation.
      expect(app).toMatch(
        /<NavLink component=\{RouterLink\} to="\/orders" label="Orders" active=\{isActive\("\/orders"\)\}/,
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
      const doc = await helper(
        `
        system Plain {
          subdomain M {
            context C {
              aggregate Thing { name: string  derived display: string = name }
              repository Things for Thing { }
            }
          }
          ui WebApp with scaffold(subdomains: [M]) { }
          deployable api { platform: node, contexts: [C], port: 3000 }
          deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
        }
      `,
        { validation: true },
      );
      const { files } = generateSystems(doc.parseResult.value as Model);
      const app = files.get("web/src/App.tsx")!;
      expect(app).toMatch(/<Divider my="xs" label="Aggregates"/);
      // No workflows / views section emitted.
      expect(app).not.toMatch(/label="Workflows"/);
      expect(app).not.toMatch(/label="Views"/);
      expect(app).not.toMatch(/data-testid="nav-workflows"/);
      expect(app).not.toMatch(/data-testid="nav-views"/);
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
    expect(app).toMatch(/function NotFound\(\) \{/);
    expect(app).toMatch(/<Route path="\*" element={<NotFound \/>} \/>/);
  });

  describe("per-page `layout:` (v1)", () => {
    // Inline DSL mirrors `examples/acme.ddd`'s minimum shape — one
    // module + api + ui + react deployable + hono deployable — so
    // the react generator runs end-to-end.  Each test adds one
    // explicit page with the layout selector under test.
    const buildSrc = (page: string): string => `
        system Acme {
          subdomain Sales {
            context S {
              aggregate Order { name: string }
              repository Orders for Order { }
            }
          }
          api SalesApi from Sales
          ui WebApp with scaffold(subdomains: [Sales]) {
            api Sales: SalesApi
            ${page}
          }
          storage primarySql { type: postgres }
          deployable api {
            platform: node
            contexts: [S]
            serves: SalesApi
            port: 3001
          }
          deployable web_app {
            platform: static
            targets: api
            ui: WebApp { Sales: api }
            port: 5173
          }
        }
      `;

    it("mounts a `layout: none` page OUTSIDE the AppShell layout-route", async () => {
      const { generateSystemFiles } = await import("../../_helpers/index.js");
      const files = await generateSystemFiles(
        buildSrc(`page Kiosk {
              route: "/kiosk"
              layout: none
              body: Heading("Kiosk")
            }`),
      );
      const app = files.get("web_app/src/App.tsx")!;
      expect(app).toBeDefined();
      // Layout route extracted; Outlet is the slot.
      expect(app).toMatch(/function AppShellLayout\(\)/);
      expect(app).toMatch(/<AppErrorBoundary>\s*<Outlet \/>\s*<\/AppErrorBoundary>/);
      // The `layout: none` page mounts as a sibling of the
      // <Route element={<AppShellLayout />}> wrapper — not nested
      // inside it.
      const re =
        /<Route path="\/kiosk" element=\{<Kiosk \/>\} \/>\s*<Route element=\{<AppShellLayout \/>\}>/;
      expect(app).toMatch(re);
    });

    it("a `layout: default` page mounts inside the AppShell layout-route alongside scaffold routes", async () => {
      const { generateSystemFiles } = await import("../../_helpers/index.js");
      const files = await generateSystemFiles(
        buildSrc(`page Console {
              route: "/console"
              layout: default
              body: Heading("Console")
            }`),
      );
      const app = files.get("web_app/src/App.tsx")!;
      expect(app).toBeDefined();
      // Inside the layout-route block (AppShellLayout's <Route>).
      const layoutBlock = app.split("<Route element={<AppShellLayout />}>")[1] ?? "";
      expect(layoutBlock).toMatch(/<Route path="\/console" element=\{<Console \/>\} \/>/);
    });
  });

  describe("design tokens (theme block → Mantine theme)", () => {
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
      expect(theme).toMatch(/headings: \{[\s\S]*?fontFamily: "Inter, system-ui, sans-serif"/);

      // main.tsx imports the theme + passes it to MantineProvider.
      const main = files.get("web_app/src/main.tsx")!;
      expect(main).toMatch(/import \{ theme \} from "\.\/theme"/);
      expect(main).toMatch(/<MantineProvider theme=\{theme\}/);
    });

    it("emits a default theme.ts even when the system declares no theme block", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Untheme {
          subdomain M {
            context C {
              aggregate A { name: string  derived display: string = name }
              repository As for A { }
            }
          }
          ui WebApp with scaffold(subdomains: [M]) { }
          deployable api { platform: dotnet, contexts: [C], port: 8080 }
          deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
        }
      `,
        { validation: true },
      );
      const model = doc.parseResult.value as Model;
      const { files } = generateSystems(model);
      // Every generated React app ships with a baseline theme so it
      // looks like a coherent product rather than untouched Mantine
      // defaults.  When the DSL declares no `theme {}`, we fall back
      // to a tasteful indigo / Inter / md-radius preset.
      const theme = files.get("web/src/theme.ts")!;
      expect(theme).toBeDefined();
      expect(theme).toMatch(/primaryColor: "brand"/);
      expect(theme).toMatch(/defaultRadius: "md"/);
      expect(theme).toMatch(/Inter/);
      // main.tsx always wires the theme — provider gets `theme={theme}`.
      const main = files.get("web/src/main.tsx")!;
      expect(main).toMatch(/from "\.\/theme"/);
      expect(main).toMatch(/<MantineProvider theme=\{theme\}/);
    });

    it("validator rejects unknown theme property names", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Bad {
          theme {
            primary: "#ff0000"
            wholeKitchenSink: "#00ff00"
          }
        }
      `,
        { validation: true },
      );
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(errors.some((e) => /unknown theme property 'wholeKitchenSink'/.test(e.message))).toBe(
        true,
      );
    });

    it("validator rejects duplicate theme property names", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Bad {
          theme {
            primary: "#ff0000"
            primary: "#00ff00"
          }
        }
      `,
        { validation: true },
      );
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(errors.some((e) => /declared more than once/.test(e.message))).toBe(true);
    });

    it("validator rejects non-hex color values", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Bad {
          theme {
            primary: "blue"
          }
        }
      `,
        { validation: true },
      );
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(errors.some((e) => /must be a CSS hex color/.test(e.message))).toBe(true);
    });

    it("validator rejects radius values outside the enum", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Bad {
          theme {
            radius: "huge"
          }
        }
      `,
        { validation: true },
      );
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(
        errors.some((e) => /must be one of none \| sm \| md \| lg \| xl/.test(e.message)),
      ).toBe(true);
    });

    it("validator rejects more than one theme block per system", async () => {
      const services = createDddServices(NodeFileSystem);
      const { parseHelper } = await import("langium/test");
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Bad {
          theme { primary: "#ff0000" }
          theme { primary: "#00ff00" }
        }
      `,
        { validation: true },
      );
      const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(errors.some((e) => /more than one 'theme \{ \.\.\. \}' block/.test(e.message))).toBe(
        true,
      );
    });
  });

  describe("workflow form pages", () => {
    it("emits an api/workflows.ts module with one Zod schema + mutation hook per workflow", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const api = files.get("web_app/src/api/workflows.ts")!;
      // Per-workflow request schema + inferred type.
      expect(api).toMatch(/export const PlaceOrderRequest = z\.object\(\{/);
      expect(api).toMatch(/customerId: z\.string\(\)/);
      expect(api).toMatch(/productId: z\.string\(\)/);
      expect(api).toMatch(/quantity: z\.number\(\)\.int\(\)/);
      expect(api).toMatch(/export type PlaceOrderRequest = z\.infer<typeof PlaceOrderRequest>/);
      // Mutation hook posts to the backend's /workflows/<slug> route.
      expect(api).toMatch(/export function usePlaceOrderWorkflow\(\)/);
      expect(api).toMatch(/api\.post\(`\/workflows\/place_order`, input\)/);
    });

    it("emits a per-workflow form page with typed inputs reusing the v4 form helpers", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const page = files.get("web_app/src/pages/workflows/place_order.tsx")!;
      // RHF + zodResolver wiring matches the aggregate-operation pattern.
      expect(page).toMatch(/import \{ Controller, useForm \} from "react-hook-form"/);
      expect(page).toMatch(/zodResolver\(PlaceOrderRequest\)/);
      expect(page).toMatch(/usePlaceOrderWorkflow/);
      // String param → TextInput; X id → Select with target's display field;
      // int → NumberInput with allowDecimal={false}.
      expect(page).toMatch(/<TextInput label="Customer Id"/);
      expect(page).toMatch(/<Select label="Product Id"[\s\S]+?__products\.data/);
      expect(page).toMatch(/<NumberInput label="Quantity"[\s\S]+?allowDecimal=\{false\}/);
      // useAllProducts pulled in for the Product id Select.
      expect(page).toMatch(/import \{ useAllProducts \} from "\.\.\/\.\.\/api\/product"/);
      // Submit button + success/error toast.
      expect(page).toMatch(/data-testid="workflow-place_order-submit"/);
      expect(page).toMatch(
        /notifications\.show\(\{ color: "green", message: "Place Order completed" \}\)/,
      );
      // After success navigate back to the index.
      expect(page).toMatch(/navigate\("\/workflows"\)/);
    });

    it("App.tsx registers /workflows + /workflows/<slug> routes and sidebar entry", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      // Index + per-workflow imports.
      expect(app).toMatch(/import WorkflowsIndex from "\.\/pages\/workflows\/index"/);
      expect(app).toMatch(/import PlaceOrderWorkflowPage from "\.\/pages\/workflows\/place_order"/);
      // Routes — index + per-workflow.
      expect(app).toMatch(/<Route path="\/workflows" element=\{<WorkflowsIndex \/>\} \/>/);
      expect(app).toMatch(
        /<Route path="\/workflows\/place_order" element=\{<PlaceOrderWorkflowPage \/>\} \/>/,
      );
      // Sidebar entry — "All workflows" parent NavLink + one
      // NavLink per workflow (navbar redesign).
      expect(app).toMatch(
        /<NavLink component=\{RouterLink\} to="\/workflows" label="All workflows"[\s\S]*?data-testid="nav-workflows"/,
      );
      expect(app).toMatch(
        /<NavLink component=\{RouterLink\} to="\/workflows\/place_order" label="Place Order"[\s\S]*?data-testid="nav-workflow-place_order"/,
      );
    });
  });

  describe("view list pages", () => {
    it("emits an api/views.ts module with a query hook per view", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const api = files.get("web_app/src/api/views.ts")!;
      // Shorthand view reuses the source aggregate's list response.
      expect(api).toMatch(/export const ActiveOrdersResponse = OrderListResponse;/);
      expect(api).toMatch(/export function useActiveOrdersView\(\)/);
      expect(api).toMatch(/api\.get\(`\/views\/active_orders`\)/);
      // Full-form view emits its own row + array schemas.
      expect(api).toMatch(/export const OrderSummaryRow = z\.object\(\{/);
      expect(api).toMatch(/orderId: z\.string\(\)/);
      expect(api).toMatch(/status: OrderStatusSchema/);
      expect(api).toMatch(/lineCount: z\.number\(\)\.int\(\)/);
      expect(api).toMatch(/export const OrderSummaryResponse = z\.array\(OrderSummaryRow\);/);
      expect(api).toMatch(/export function useOrderSummaryView\(\)/);
    });

    it("App.tsx registers /views + /views/<slug> routes and sidebar entry", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const app = files.get("web_app/src/App.tsx")!;
      expect(app).toMatch(/import ViewsIndex from "\.\/pages\/views\/index"/);
      expect(app).toMatch(/import ActiveOrdersViewPage from "\.\/pages\/views\/active_orders"/);
      expect(app).toMatch(/import OrderSummaryViewPage from "\.\/pages\/views\/order_summary"/);
      expect(app).toMatch(/<Route path="\/views" element=\{<ViewsIndex \/>\} \/>/);
      expect(app).toMatch(
        /<Route path="\/views\/active_orders" element=\{<ActiveOrdersViewPage \/>\} \/>/,
      );
      expect(app).toMatch(
        /<NavLink component=\{RouterLink\} to="\/views" label="All views"[\s\S]*?data-testid="nav-views"/,
      );
      expect(app).toMatch(
        /<NavLink component=\{RouterLink\} to="\/views\/active_orders" label="Active Orders"[\s\S]*?data-testid="nav-view-active_orders"/,
      );
    });

    it("gates the /views index import+route on a scaffold ViewsIndex page existing", () => {
      // The ViewsIndex (and WorkflowsIndex) singleton index page is only
      // synthesised by the scaffold macro.  An explicit view page in a
      // non-scaffold ui has none, so the App shell must NOT import
      // `./pages/views/index` (it would dangle → TS2307) — but the
      // per-view page still mounts.  Mirrors the `hasScaffoldHome` gate.
      const views = [{ name: "ActiveProjects" }] as unknown as Parameters<
        typeof prepareAppShellVM
      >[2];
      const args = (hasViewsIndex: boolean) =>
        prepareAppShellVM(
          [],
          [],
          views,
          "Sys",
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          [],
          hasViewsIndex,
          true,
        );

      const noIndex = args(false);
      expect(noIndex.imports.some((i) => i.from === "./pages/views/index")).toBe(false);
      expect(noIndex.routes.some((r) => r.path === "/views")).toBe(false);
      // the per-view page is still wired regardless.
      expect(noIndex.imports.some((i) => i.from === "./pages/views/active_projects")).toBe(true);
      expect(noIndex.routes.some((r) => r.path === "/views/active_projects")).toBe(true);

      const withIndex = args(true);
      expect(withIndex.imports.some((i) => i.from === "./pages/views/index")).toBe(true);
      expect(withIndex.routes.some((r) => r.path === "/views")).toBe(true);
    });
  });

  describe("DSL e2e for ui.workflows.* + ui.views.*", () => {
    it("emits a Playwright page object per workflow", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const po = files.get("web_app/e2e/pages/workflows/place_order.ts")!;
      expect(po).toMatch(/export class PlaceOrderWorkflowPage/);
      // Typed `fill` accepting Partial<PlaceOrderRequest>.
      expect(po).toMatch(/async fill\(input: Partial<PlaceOrderRequest>\): Promise<this>/);
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
      // rows() reads the rendered table body structurally (pack-agnostic
      // `<tbody><tr><td>`), indexing cells in column order — so it returns
      // the actual rendered row content, not empty stubs.
      expect(po).toMatch(/async rows\(\): Promise<OrderSummaryRowText\[\]>/);
      expect(po).toMatch(/getByTestId\("view-order_summary"\)\.locator\("tbody tr"\)/);
      expect(po).toMatch(/const cells = body\.nth\(i\)\.locator\("td"\)/);
      // First projected column maps to cell 0.
      expect(po).toMatch(/const c_0 = \(await cells\.nth\(0\)\.innerText\(\)\)\.trim\(\)/);
      expect(po).toMatch(/orderId: c_0/);
    });

    it("UI spec lowers ui.workflows.<name>(...) to the generated page object's run()", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const ui = files.get("web_app/e2e/Acme.ui.spec.ts")!;
      // Page-object import.
      expect(ui).toMatch(
        /import \{ PlaceOrderWorkflowPage \} from "\.\/pages\/workflows\/place_order"/,
      );
      // The workflow call lowers to `await new <Cap>WorkflowPage(page).run({...})`.
      expect(ui).toMatch(/await new PlaceOrderWorkflowPage\(page\)\.run\(/);
    });

    it("UI spec lowers ui.views.<name>() to the generated page object's rows()", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const ui = files.get("web_app/e2e/Acme.ui.spec.ts")!;
      expect(ui).toMatch(
        /import \{ ActiveOrdersViewPage \} from "\.\/pages\/views\/active_orders"/,
      );
      // The view call lowers to a goto + rows() pair, wrapped so the
      // let-binding resolves to the array (not a Promise).
      expect(ui).toMatch(/new ActiveOrdersViewPage\(page\)\.goto\(\)/);
      expect(ui).toMatch(/await __view\.rows\(\)/);
    });

    it("validator rejects ui.workflows.<unknown>", async () => {
      const { parseHelper } = await import("langium/test");
      const { lowerModel } = await import("../../../src/ir/lower/lower.js");
      const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
      const { validateLoomModel } = await import("../../../src/ir/validate/validate.js");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Demo {
          subdomain M {
            context C {
              aggregate A { name: string  derived display: string = name }
              repository As for A { }
            }
          }
          ui WebApp with scaffold(subdomains: [M]) { }
          deployable api { platform: dotnet, contexts: [C], port: 8080 }
          deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
          test e2e "bad" against web {
            ui.workflows.doesNotExist({})
          }
        }
      `,
        { validation: true },
      );
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
      const { lowerModel } = await import("../../../src/ir/lower/lower.js");
      const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
      const { validateLoomModel } = await import("../../../src/ir/validate/validate.js");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
        system Demo {
          subdomain M {
            context C {
              aggregate A { name: string  derived display: string = name }
              repository As for A { }
            }
          }
          ui WebApp with scaffold(subdomains: [M]) { }
          deployable api { platform: dotnet, contexts: [C], port: 8080 }
          deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
          test e2e "bad" against web {
            let r = ui.views.doesNotExist()
          }
        }
      `,
        { validation: true },
      );
      const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
      const diags = validateLoomModel(loom);
      expect(
        diags.some(
          (d) => d.severity === "error" && /unknown view 'ui\.views\.doesNotExist'/.test(d.message),
        ),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // wire-boundary validation on the React side.
  // -------------------------------------------------------------------
  describe("invariants on the wire (React Zod refines)", () => {
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
        /AddLineOrderRequest = z\.object\(\{[\s\S]*qty: z\.number\(\)\.int\(\)\.min\(1\)/,
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
      expect(orderApi).toMatch(/export const ConfirmOrderRequest = z\.object\(\{\s*\}\);/);
    });

    it("RHF still binds zodResolver to the refined CreateProductRequest schema", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const newProduct = files.get("web_app/src/pages/products/new.tsx")!;
      // Existing contract — refines compose into the same
      // schema name, so the form keeps working.
      expect(newProduct).toMatch(/zodResolver\(CreateProductRequest\)/);
    });
  });

  // -------------------------------------------------------------------
  // DSL extensions on the React side.
  // -------------------------------------------------------------------
  describe("DSL extensions", () => {
    it("absorbs `string.matches(literal)` as `z.string().regex(/.../)`", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          system Acme {
            subdomain M {
              context Auth {
                aggregate User {
                  email: string
                  derived display: string = email
                  invariant email.matches("^[^@]+@.+$")
                }
                repository Users for User { }
              }
            }
            ui WebApp with scaffold(subdomains: [M]) { }
            deployable api { platform: dotnet, contexts: [Auth], port: 8080 }
            deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
          }
        `,
        { validation: true },
      );
      const { files } = generateSystems(doc.parseResult.value as Model);
      const userApi = files.get("web/src/api/user.ts")!;
      expect(userApi).toMatch(/email: z\.string\(\)\.regex\(\/\^\[\^@\]\+@\.\+\$\/\)/);
    });

    it("desugars `field: T check <expr>` to an invariant on the parent", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          system Acme {
            subdomain M {
              context Catalog {
                aggregate Product {
                  sku:  string check sku.length >= 1 && sku.length <= 32
                  derived display: string = sku
                  name: string check name.length <= 120
                }
                repository Products for Product { }
              }
            }
            ui WebApp with scaffold(subdomains: [M]) { }
            deployable api { platform: dotnet, contexts: [Catalog], port: 8080 }
            deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
          }
        `,
        { validation: true },
      );
      const { files } = generateSystems(doc.parseResult.value as Model);
      const productApi = files.get("web/src/api/product.ts")!;
      // Both checks are absorbed into idiomatic chains.
      expect(productApi).toMatch(/sku: z\.string\(\)\.min\(1\)\.max\(32\)/);
      expect(productApi).toMatch(/name: z\.string\(\)\.max\(120\)/);
    });

    it("`private invariant` is skipped from wire schemas (server-only)", async () => {
      const { parseHelper } = await import("langium/test");
      const services = createDddServices(NodeFileSystem);
      const helper = parseHelper(services.Ddd);
      const doc = await helper(
        `
          system Acme {
            subdomain M {
              context Acct {
                aggregate User {
                  username: string
                  derived display: string = username
                  private invariant username.length >= 3
                }
                repository Users for User { }
              }
            }
            ui WebApp with scaffold(subdomains: [M]) { }
            deployable api { platform: dotnet, contexts: [Acct], port: 8080 }
            deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
          }
        `,
        { validation: true },
      );
      const { files } = generateSystems(doc.parseResult.value as Model);
      const userApi = files.get("web/src/api/user.ts")!;
      // The private invariant must NOT contribute a min(3) chain or a refine.
      expect(userApi).toMatch(
        /CreateUserRequest = z\.object\(\{\s*username: z\.string\(\),\s*\}\);/,
      );
      expect(userApi).not.toMatch(/\.min\(3\)/);
      expect(userApi).not.toMatch(/\.refine\(/);
    });
  });
});
