import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Fullstack `platform: python, ui: WebApp` mode (plan S18 — dotnet embed
// parity).  One deployable that BOTH serves the API AND hosts a React
// SPA: routers move under /api/* so the SPA's path namespace stays free
// for client-side routing, main.py serves wwwroot/ with an index.html
// fallback, the Dockerfile becomes multi-stage (build ClientApp/ → copy
// dist to wwwroot/), and the React project is generated under
// ClientApp/ hitting `/api/...` on its own origin.  Backend-only python
// (no `ui:`) stays byte-identical.  Verified live (index.html at /,
// client-route fallback, assets, /api CRUD, /health at root).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/fullstack.ddd"),
  "utf8",
);

async function build(source: string) {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("fullstack python — embedded SPA alongside the API", () => {
  it("generates ClientApp/ next to the app and hits /api on its own origin", async () => {
    const files = await build(FIXTURE);
    expect(files.has("app/app/main.py")).toBe(true);
    expect(files.has("app/ClientApp/src/main.tsx")).toBe(true);
    expect(files.get("app/ClientApp/.gitignore")).toContain("node_modules");
    // The python project owns the container surfaces.
    expect(files.has("app/ClientApp/Dockerfile")).toBe(false);
    expect(files.has("app/ClientApp/certs/.gitkeep")).toBe(false);
    const apiConfig = [...files.keys()].find((k) => k.startsWith("app/ClientApp/src/api/"));
    expect(apiConfig).toBeDefined();
  });

  it("routers mount under /api and the SPA fallback registers last", async () => {
    const files = await build(FIXTURE);
    const main = files.get("app/app/main.py")!;
    expect(main).toContain('app.include_router(order_router, prefix="/api")');
    expect(main).toContain('_WWWROOT = FilePath(__file__).resolve().parent.parent / "wwwroot"');
    expect(main).toContain('@app.get("/{spa_path:path}", include_in_schema=False)');
    expect(main).toContain('return FileResponse(_WWWROOT / "index.html")');
    // Catch-all registers after the routers + probes (Starlette order).
    expect(main.indexOf("app.include_router")).toBeLessThan(main.indexOf("spa_path"));
    expect(main.indexOf('@app.get("/health")')).toBeLessThan(main.indexOf("spa_path"));
  });

  it("the Dockerfile is multi-stage: ClientApp build → wwwroot copy", async () => {
    const files = await build(FIXTURE);
    const docker = files.get("app/Dockerfile")!;
    expect(docker).toContain("FROM node:24-alpine AS spa-build");
    expect(docker).toContain("COPY ClientApp/ ./");
    expect(docker).toContain("COPY --from=spa-build /spa/dist ./wwwroot");
    expect(docker).toContain('CMD ["uvicorn", "app.main:app"');
  });

  it("backend-only python serves /api routes and emits no SPA surface", async () => {
    const source = FIXTURE.replace(/ {2}ui WebApp[^\n]*\n\n?/, "").replace(/\n {4}ui: WebApp/, "");
    const files = await build(source);
    const main = files.get("app/app/main.py")!;
    expect(main).toContain('app.include_router(order_router, prefix="/api")');
    expect(main).not.toContain("spa_path");
    expect(main).not.toContain("wwwroot");
    expect([...files.keys()].some((k) => k.includes("ClientApp"))).toBe(false);
    expect(files.get("app/Dockerfile")!).not.toContain("spa-build");
  });
});
