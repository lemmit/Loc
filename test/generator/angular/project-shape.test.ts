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
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 3000 }
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
      ".dockerignore",
      "certs/.gitkeep",
    ];
    for (const path of expected) {
      expect(files.has(path), `missing emitted file: ${path}`).toBe(true);
    }
  });

  it("bootstraps a standalone app via bootstrapApplication + appConfig", async () => {
    const files = await angularFiles();
    expect(files.get("src/main.ts")!).toContain("bootstrapApplication(AppComponent, appConfig)");
    const cfg = files.get("src/app/app.config.ts")!;
    expect(cfg).toContain("provideRouter(routes)");
    expect(cfg).toContain("provideHttpClient(withFetch())");
    expect(cfg).toContain("provideAnimationsAsync()");
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
    // DI-native data layer — no external query lib.
    expect(pkg.dependencies["@tanstack/angular-query-experimental"]).toBeUndefined();
  });

  it("index.html is the Angular host (<app-root>), not a Vite manual-mount page", async () => {
    const html = (await angularFiles()).get("src/index.html")!;
    expect(html).toContain("<app-root></app-root>");
    expect(html).toContain('<base href="/" />');
    expect(html).not.toContain("/src/main.ts");
  });

  // --- Per-aggregate API module (data path sub-slice A) ------------------
  it("emits an idiomatic @Injectable service + signal-backed read factory per aggregate", async () => {
    const api = (await angularFiles()).get("src/api/customer.ts")!;
    // Response interface derived from the aggregate's wire shape.
    expect(api).toContain("export interface CustomerResponse {");
    expect(api).toContain("id: string;");
    expect(api).toContain("name: string;");
    // DI-native HttpClient service — not a fetch wrapper, no TanStack.
    expect(api).toContain('import { HttpClient } from "@angular/common/http";');
    expect(api).toContain('@Injectable({ providedIn: "root" })');
    expect(api).toContain("export class CustomerService {");
    expect(api).toContain("this.http.get<CustomerResponse[]>(`${API_BASE_URL}/customers`)");
    // Signal-backed read factory mirrors the TanStack result shape.
    expect(api).toContain("export function useAllCustomers() {");
    expect(api).toContain("const data = signal<CustomerResponse[]>([]);");
    expect(api).toContain("return { data, isLoading, isError };");
  });
});
