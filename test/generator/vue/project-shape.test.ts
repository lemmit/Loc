import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vue generator — project-shape inventory (vue-frontend-plan.md
// Slice 3).  Pins the emitted file set + the load-bearing content
// seams: the shared api-module builder swapped to vue-query, the
// vue-router route table, the Vuetify shell tier, and the stub page
// SFCs that hold the slot until the walker slice.
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
    ui WebApp {
      page CustomerHome {
        route: "/"
        title: "Customers home"
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
  }
`;

async function vueFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

describe("vue generator — project shape", () => {
  it("emits the full Vite+Vue project shell", async () => {
    const files = await vueFiles();
    for (const expected of [
      "package.json",
      "tsconfig.json",
      "tsconfig.node.json",
      "vite.config.ts",
      "index.html",
      "Dockerfile",
      ".dockerignore",
      "src/main.ts",
      "src/App.vue",
      "src/theme.ts",
      "src/router.ts",
      "src/logger.ts",
      "src/api/client.ts",
      "src/api/config.ts",
      "src/api/customer.ts",
      "src/lib/format.ts",
      "src/lib/form.ts",
      "src/pages/NotFound.vue",
      "src/pages/customer_home.vue",
    ]) {
      expect(files.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it("api module rides the shared _frontend builder with vue-query naming", async () => {
    const files = await vueFiles();
    const api = files.get("src/api/customer.ts")!;
    expect(api).toContain(`from "@tanstack/vue-query"`);
    expect(api).not.toContain("react-query");
    // Same composable surface the vueTarget's buildHookUse expects.
    expect(api).toContain(
      "export function useAllCustomers(query: MaybeRefOrGetter<AllQueryInput> = () => ({}))",
    );
    expect(api).toContain("export function useCreateCustomer()");
    expect(api).toContain("export function useDeleteCustomer()");
    expect(api).toContain("export const CustomerResponse = z.object({");
  });

  it("router.ts mounts the declared page at its route + a catch-all NotFound", async () => {
    const files = await vueFiles();
    const router = files.get("src/router.ts")!;
    expect(router).toContain(`import CustomerHome from "./pages/customer_home.vue";`);
    expect(router).toContain(`{ path: "/", component: CustomerHome }`);
    expect(router).toContain(`{ path: "/:pathMatch(.*)*", component: NotFound }`);
    expect(router).toContain("createWebHistory");
  });

  it("page stubs carry the page testid + static title", async () => {
    const files = await vueFiles();
    const page = files.get("src/pages/customer_home.vue")!;
    expect(page).toContain('data-testid="page-customer-home"');
    expect(page).toContain("Customers home");
    expect(page).toContain('<script setup lang="ts">');
  });

  it("package.json layers vuetify over the vue1 stack", async () => {
    const files = await vueFiles();
    const pkg = JSON.parse(files.get("package.json")!) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies.vue).toBeTruthy();
    expect(pkg.dependencies["vue-router"]).toBeTruthy();
    expect(pkg.dependencies["@tanstack/vue-query"]).toBeTruthy();
    expect(pkg.dependencies.vuetify).toBeTruthy();
    expect(pkg.devDependencies["vue-tsc"]).toBeTruthy();
    expect(pkg.devDependencies["@vitejs/plugin-vue"]).toBeTruthy();
  });

  it("index.html mounts /src/main.ts into #app (the vue shared layer, not vite/'s)", async () => {
    const files = await vueFiles();
    const html = files.get("index.html")!;
    expect(html).toContain('<div id="app">');
    expect(html).toContain("/src/main.ts");
    expect(html).toContain("<title>Customers home</title>");
  });

  it("compose service exposes the vite preview port with the api url env", async () => {
    const all = await generateSystemFiles(SOURCE);
    const compose = all.get("docker-compose.yml")!;
    expect(compose).toContain("VITE_API_BASE_URL");
    // Same-origin: the preview proxy is pointed at the backend SERVICE so the
    // bundle's relative `/api` resolves under `vite preview` in compose.
    expect(compose).toMatch(/VITE_API_PROXY_TARGET: "http:\/\/\w[\w-]*:\d+"/);
    expect(compose).toMatch(/3003:3000/);
    // Both server and preview proxy `/api` in the generated vite config.
    const vite = [...all.entries()].find(([k]) => k.endsWith("vite.config.ts"))![1];
    expect(vite.match(/proxy: \{ "\/api":/g)?.length).toBe(2);
  });
});
