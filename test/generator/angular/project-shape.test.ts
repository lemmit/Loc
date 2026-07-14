import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Angular generator — project shape (angular-frontend-plan.md Slice 3).
// Asserts the walking-skeleton emits a complete, buildable empty Angular
// project tree (structure-level; the `ng build` runtime check is the opt-in
// LOOM_ANGULAR_BUILD gate).  Runs the full pipeline through the platform
// surface, then filters to the angular deployable's `web/` subtree.
// ---------------------------------------------------------------------------

const SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Customer with crudish {
          name: string
        }
      }
    }
    ui Web { }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function angularFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

describe("angular generator — project shape", () => {
  it("emits the full standalone Angular project shell", async () => {
    const files = await angularFiles();
    const expected = [
      "package.json",
      "angular.json",
      "tsconfig.json",
      "tsconfig.app.json",
      "src/main.ts",
      "src/index.html",
      "src/styles.css",
      "src/app/app.config.ts",
      "src/app/app.component.ts",
      "src/app/app.routes.ts",
      "src/app/home.component.ts",
      "src/app/not-found.component.ts",
      "src/lib/format.ts",
      "src/api/client.ts",
      "src/api/config.ts",
      "src/logger.ts",
      "Dockerfile",
      "server.mjs",
      ".dockerignore",
      "certs/.gitkeep",
    ];
    for (const path of expected) {
      expect(files.has(path), `missing emitted file: ${path}`).toBe(true);
    }
  });

  it("serves the bundle via server.mjs with a same-origin /api proxy (not bare `serve`)", async () => {
    const all = await generateSystemFiles(SOURCE);
    const files = await angularFiles();
    // The static host proxies the bundle's relative `/api` to the backend,
    // target from VITE_API_PROXY_TARGET (dev fallback baked).
    const server = files.get("server.mjs")!;
    expect(server).toContain('process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000"');
    expect(server).toMatch(/url\.startsWith\("\/api\/"\)/);
    expect(server).toContain("proxyRequest");
    // Dockerfile runs it (and `serve` is gone — it cannot proxy).
    const dockerfile = files.get("Dockerfile")!;
    expect(dockerfile).toContain('CMD ["node", "server.mjs"]');
    expect(dockerfile).not.toMatch(/serve -s|"serve"/);
    // Compose points the proxy at the backend SERVICE (not localhost).
    expect(all.get("docker-compose.yml")!).toMatch(/VITE_API_PROXY_TARGET: "http:\/\/api:3000"/);
  });

  it("bootstraps a standalone app via bootstrapApplication + appConfig", async () => {
    const files = await angularFiles();
    expect(files.get("src/main.ts")!).toContain("bootstrapApplication(AppComponent, appConfig)");
    const cfg = files.get("src/app/app.config.ts")!;
    expect(cfg).toContain("provideRouter(routes)");
    expect(cfg).toContain("provideHttpClient(withFetch())");
    expect(cfg).toContain("provideAnimationsAsync()");
    // TanStack QueryClient backs the server-state cache.
    expect(cfg).toContain("provideTanStackQuery(new QueryClient())");
  });

  it("app shell is a standalone app-root component with the system name baked in", async () => {
    const shell = (await angularFiles()).get("src/app/app.component.ts")!;
    expect(shell).toContain('selector: "app-root"');
    expect(shell).toContain("<router-outlet />");
    expect(shell).toContain("Shop"); // humanize(sys.name)
    expect(shell).toContain('data-testid="nav-sidebar"');
  });

  it("route table mounts Home at the root + a wildcard NotFound", async () => {
    const routes = (await angularFiles()).get("src/app/app.routes.ts")!;
    expect(routes).toContain("export const routes: Routes = [");
    expect(routes).toContain('{ path: "", component: HomeComponent }');
    expect(routes).toContain('{ path: "**", component: NotFoundComponent }');
  });

  it("angular.json uses the application builder, dist/browser output, and the Material theme", async () => {
    const ng = JSON.parse((await angularFiles()).get("angular.json")!);
    const build = ng.projects.app.architect.build;
    expect(build.builder).toBe("@angular/build:application");
    expect(build.options.outputPath).toBe("dist");
    expect(build.options.browser).toBe("src/main.ts");
    expect(build.options.styles).toContain("@angular/material/prebuilt-themes/azure-blue.css");
  });

  it("package.json layers Angular Material over the ng1 stack", async () => {
    const pkg = JSON.parse((await angularFiles()).get("package.json")!);
    expect(pkg.dependencies["@angular/core"]).toBeTruthy();
    expect(pkg.dependencies["@angular/router"]).toBeTruthy();
    expect(pkg.dependencies["@angular/material"]).toBeTruthy();
    expect(pkg.scripts.build).toBe("ng build");
    // TanStack Angular Query backs the server-state layer (caching + invalidation).
    expect(pkg.dependencies["@tanstack/angular-query-experimental"]).toBeTruthy();
  });

  it("index.html is the Angular host (<app-root>), not a Vite manual-mount page", async () => {
    const html = (await angularFiles()).get("src/index.html")!;
    expect(html).toContain("<app-root></app-root>");
    expect(html).toContain('<base href="/" />');
    expect(html).not.toContain("/src/main.ts");
  });

  // --- Per-aggregate API module (data path sub-slice A) ------------------
  it("emits an @Injectable HttpClient service + an injectQuery read factory per aggregate", async () => {
    const api = (await angularFiles()).get("src/api/customer.ts")!;
    // Response interface derived from the aggregate's wire shape.
    expect(api).toContain("export interface CustomerResponse {");
    expect(api).toContain("id: string;");
    expect(api).toContain("name: string;");
    // HttpClient service handles the raw request; the query layer wraps it.
    expect(api).toContain('import { HttpClient } from "@angular/common/http";');
    expect(api).toContain('@Injectable({ providedIn: "root" })');
    expect(api).toContain("export class CustomerService {");
    // Paged-by-default findAll (M-T2.6): the service returns the `<Agg>Paged`
    // envelope and the factory takes a page/pageSize/sort/dir query getter.
    expect(api).toContain("this.http.get<CustomerPaged>(");
    // TanStack injectQuery read factory — shared cache keyed by the collection tag.
    expect(api).toContain(
      'import { QueryClient, injectMutation, injectQuery } from "@tanstack/angular-query-experimental";',
    );
    expect(api).toContain("export function useAllCustomers(query: () => AllQuery = () => ({})) {");
    expect(api).toContain('queryKey: ["customers", "list", query()] as const,');
    expect(api).toContain("queryFn: () => firstValueFrom(service.findAll(query())),");
  });

  it("emits the create request type + service POST + an injectMutation factory that invalidates", async () => {
    const api = (await angularFiles()).get("src/api/customer.ts")!;
    // Client-suppliable create payload.
    expect(api).toContain("export interface CreateCustomerRequest {");
    expect(api).toContain("name: string;");
    // Service POST + rxjs->promise mutation.
    expect(api).toContain("create(input: CreateCustomerRequest) {");
    expect(api).toContain("this.http.post<{ id: string }>(`${API_BASE_URL}/customers`, input)");
    expect(api).toContain('import { firstValueFrom } from "rxjs";');
    // TanStack injectMutation — on success invalidates the collection query.
    expect(api).toContain(
      'import { QueryClient, injectMutation, injectQuery } from "@tanstack/angular-query-experimental";',
    );
    expect(api).toContain("export function useCreateCustomer() {");
    expect(api).toContain("return injectMutation(() => ({");
    expect(api).toContain(
      "mutationFn: (input: CreateCustomerRequest) => firstValueFrom(service.create(input)),",
    );
    expect(api).toContain(
      'onSuccess: () => queryClient.invalidateQueries({ queryKey: ["customers"] }),',
    );
  });
});

// ---------------------------------------------------------------------------
// Per-operation mutations — every public domain operation gets a
// `POST /<tag>/:id/<op>` service method + `use<Op><Agg>(id)` signal factory,
// the data foundation the op-form / Modal renderers hoist.  (ng build-verified
// separately.)
// ---------------------------------------------------------------------------

const OP_SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          customerId: string
          operation cancel() { }
          operation note(reason: string) { }
        }
      }
    }
    ui Web { }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

describe("angular generator — per-operation mutations", () => {
  it("emits a request type + service POST + signal factory per public operation", async () => {
    const all = await generateSystemFiles(OP_SOURCE);
    const api = all.get("web/src/api/order.ts")!;
    // No-param op → empty request interface.
    expect(api).toContain("export interface CancelOrderRequest {");
    // Param-bearing op → typed request.
    expect(api).toContain("export interface NoteOrderRequest {");
    expect(api).toContain("reason: string;");
    // Service methods POST to /<tag>/:id/<op> (asserted in pieces to avoid a
    // literal template placeholder in the test source).
    expect(api).toContain("cancel(id: string, input: CancelOrderRequest) {");
    expect(api).toContain("this.http.post<void>(");
    expect(api).toContain("/cancel`, input)");
    expect(api).toContain("note(id: string, input: NoteOrderRequest) {");
    // injectMutation factories carry the id in their variables (`{ id, input }`),
    // so an async record id resolves at call time; onSuccess invalidates the
    // affected record + collection queries.
    expect(api).toContain("export function useCancelOrder() {");
    expect(api).toContain("export function useNoteOrder() {");
    expect(api).toContain("mutationFn: (vars: { id: string; input: CancelOrderRequest }) =>");
    expect(api).toContain("firstValueFrom(service.cancel(vars.id, vars.input)),");
    expect(api).toContain('.invalidateQueries({ queryKey: ["order", vars.id] })');
    expect(api).toContain('.then(() => queryClient.invalidateQueries({ queryKey: ["orders"] })),');
  });
});
