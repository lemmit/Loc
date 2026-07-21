// ---------------------------------------------------------------------------
// Java backend — `hosts:` fullstack embed (M-T6.5, D-PHOENIX-SURFACE).
//
// A `platform: java` deployable can `hosts:` a separately-declared
// `ui { }` block (which owns its `framework:`), embedding that
// framework's SPA into the Spring project — the dotnet `hosts:` twin.
// This reuses the exact `ui:` embedded-SPA machinery (`uiName` falls back
// to the first hosted ui in lowering), so the emitted Spring surface is
// identical: controllers under /api/*, SpaWebConfig serving UI_DIR with
// an index.html fallback, the SPA under ClientApp/, and a node spa-build
// Dockerfile stage.  The only per-framework difference is the SPA build
// output dir the Dockerfile copies (Vite `dist/`, SvelteKit `build/`).
//
// Before M-T6.5 a `hosts:` binding on java was rejected by
// `loom.java-fullstack-unsupported`; that gate is now removed (dotnet
// never had it), reaching full hosting parity with dotnet.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

/** A java deployable hosting a `framework:`-owning ui block via `hosts:`. */
function src(framework: "react" | "vue" | "svelte", design: string): string {
  return `system JH {
  subdomain D {
    context Shop {
      aggregate Product with crudish {
        name: string
        price: money
      }
      repository Products for Product { }
    }
  }
  api A from D
  ui Store {
    framework: ${framework}
    page Products {
      route: "/products"
      title: "Products"
      body: Stack { Heading { "Products", level: 2 } }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable jhApp {
    platform: java
    contexts: [Shop]
    dataSources: [st]
    serves: A
    hosts: Store
    port: 8081
    design: ${design}
  }
}
`;
}

const ROOT = "jh_app/src/main/java/com/loom/jhapp";

describe("java generator — hosts: fullstack embed (M-T6.5)", () => {
  it("no longer rejects a hosts: binding (the java-fullstack gate is removed)", async () => {
    const loom = await buildLoomModel(src("react", "mantine"));
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.java-fullstack-unsupported",
    );
    expect(errors).toEqual([]);
  });

  it("moves controllers under /api and prefixes the Location header", async () => {
    const files = await generateSystemFiles(src("react", "mantine"));
    const c = files.get(`${ROOT}/features/products/ProductsController.java`)!;
    expect(c).toContain('@RequestMapping("/api/products")');
    expect(c).toContain('URI.create("/api/products/" + id.value())');
  });

  it("emits SpaWebConfig with the / forward and the index.html fallback resolver", async () => {
    const cfg = (await generateSystemFiles(src("react", "mantine"))).get(
      `${ROOT}/config/SpaWebConfig.java`,
    )!;
    expect(cfg).toContain('registry.addViewController("/").setViewName("forward:/index.html");');
    expect(cfg).toContain('registry.addResourceHandler("/**")');
    expect(cfg).toContain('System.getenv().getOrDefault("UI_DIR", "/app/ui")');
    expect(cfg).toContain('return location.createRelative("index.html");');
  });

  it("embeds the hosted react SPA under ClientApp/ targeting /api, without project-root files", async () => {
    const files = await generateSystemFiles(src("react", "mantine"));
    expect(files.has("jh_app/ClientApp/package.json")).toBe(true);
    expect(files.has("jh_app/ClientApp/Dockerfile")).toBe(false);
    const api = [...files.keys()].find((k) => k.startsWith("jh_app/ClientApp/src/api/"));
    expect(api).toBeDefined();
  });

  it("Dockerfile gains the node SPA stage copying the vite dist to /app/ui (react)", async () => {
    const docker = (await generateSystemFiles(src("react", "mantine"))).get("jh_app/Dockerfile")!;
    expect(docker).toContain("FROM node:22-alpine AS spa-build");
    expect(docker).toContain("COPY --from=spa-build /spa/dist /app/ui");
  });

  // Framework dispatch — the payoff of hosts:, which a `ui:` sugar mount
  // (react-only default on java) cannot express.  Vue rides the same vite
  // `dist/`; SvelteKit builds to `build/`, so the Dockerfile copy differs.
  it("dispatches a hosted vue SPA (vite dist) into ClientApp/", async () => {
    const files = await generateSystemFiles(src("vue", "vuetify"));
    expect(files.has("jh_app/ClientApp/package.json")).toBe(true);
    expect(files.has(`${ROOT}/config/SpaWebConfig.java`)).toBe(true);
    expect(files.get("jh_app/Dockerfile")!).toContain("COPY --from=spa-build /spa/dist /app/ui");
  });

  it("dispatches a hosted svelte SPA (SvelteKit build) into ClientApp/", async () => {
    const files = await generateSystemFiles(src("svelte", "shadcnSvelte"));
    expect(files.has("jh_app/ClientApp/package.json")).toBe(true);
    expect(files.has("jh_app/ClientApp/svelte.config.js")).toBe(true);
    expect(files.get("jh_app/Dockerfile")!).toContain("COPY --from=spa-build /spa/build /app/ui");
  });

  it("a standalone java deployable still serves /api and emits no SPA files", async () => {
    const standalone = `system JH {
  subdomain D {
    context Shop {
      aggregate Product with crudish { name: string   price: money }
      repository Products for Product { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable jhApp {
    platform: java
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 8081
  }
}
`;
    const files = await generateSystemFiles(standalone);
    const c = files.get(`${ROOT}/features/products/ProductsController.java`)!;
    expect(c).toContain('@RequestMapping("/api/products")');
    expect([...files.keys()].some((k) => k.includes("ClientApp"))).toBe(false);
    expect(files.has(`${ROOT}/config/SpaWebConfig.java`)).toBe(false);
  });
});
