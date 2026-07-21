// ---------------------------------------------------------------------------
// Java backend — embedded-SPA fullstack mount (`ui:` on a java
// deployable, the dotnet wwwroot analog).  Controllers move under
// /api/*, SpaWebConfig serves the bundle from UI_DIR (default /app/ui)
// with the index.html fallback client-side routers need (plus a "/"
// view-controller forward — the empty path never reaches the resource
// resolver), the React project lands under ClientApp/, and the
// multi-stage Dockerfile gains a node build stage.  The auth filter,
// when present, guards only /api/*.  Boot-verified end-to-end against
// Postgres + a real `npm run build` bundle via
// test/e2e/fixtures/java-build/fullstack.ddd (root 200, client-route
// fallback, /api CRUD with prefixed Location, assets, openapi.json).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/fullstack.ddd", "utf8");

const ROOT = "fs_app/src/main/java/com/loom/fsapp";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — embedded-SPA fullstack mount", () => {
  it("passes validation (both the ui: and hosts: mounts are supported; M-T6.5)", async () => {
    const loom = await buildLoomModel(SRC);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.java-fullstack-unsupported",
    );
    expect(errors).toEqual([]);
  });

  it("controllers move under /api and the Location header carries the prefix", async () => {
    const c = (await files()).get(`${ROOT}/features/products/ProductsController.java`)!;
    expect(c).toContain('@RequestMapping("/api/products")');
    expect(c).toContain('URI.create("/api/products/" + id.value())');
  });

  it("emits SpaWebConfig with the / forward and the index.html fallback resolver", async () => {
    const cfg = (await files()).get(`${ROOT}/config/SpaWebConfig.java`)!;
    expect(cfg).toContain('registry.addViewController("/").setViewName("forward:/index.html");');
    expect(cfg).toContain('registry.addResourceHandler("/**")');
    expect(cfg).toContain('System.getenv().getOrDefault("UI_DIR", "/app/ui")');
    expect(cfg).toContain('return location.createRelative("index.html");');
  });

  it("ships the React project under ClientApp/ targeting /api, without project-root files", async () => {
    const files_ = await files();
    expect(files_.has("fs_app/ClientApp/package.json")).toBe(true);
    expect(files_.has("fs_app/ClientApp/Dockerfile")).toBe(false);
    const api = [...files_.keys()].find((k) => k.startsWith("fs_app/ClientApp/src/api/"));
    expect(api).toBeDefined();
  });

  it("Dockerfile gains the node SPA stage copying dist to /app/ui", async () => {
    const docker = (await files()).get("fs_app/Dockerfile")!;
    expect(docker).toContain("FROM node:22-alpine AS spa-build");
    expect(docker).toContain("COPY --from=spa-build /spa/dist /app/ui");
  });

  it("a standalone java deployable still serves /api routes and emits no SPA files", async () => {
    const standalone = SRC.replace("    ui: Admin\n", "").replace(
      "  ui Admin with scaffold(subdomains: [D]) { }\n",
      "",
    );
    const files_ = await generateSystemFiles(standalone);
    const c = files_.get(`${ROOT}/features/products/ProductsController.java`)!;
    expect(c).toContain('@RequestMapping("/api/products")');
    expect([...files_.keys()].some((k) => k.includes("ClientApp"))).toBe(false);
    expect(files_.has(`${ROOT}/config/SpaWebConfig.java`)).toBe(false);
  });
});
