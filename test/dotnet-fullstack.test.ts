import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateSystems } from "../src/system/index.js";
import type { Model } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Part B — fullstack `platform: dotnet, ui: WebApp` mode.
//
// A single .NET deployable that BOTH serves an API AND hosts a React
// SPA from wwwroot/.  Mirrors the proven phoenixLiveView fullstack
// shape: one project, one container, one compose service.  The .NET
// project's controllers move to `/api/*` so the SPA's path namespace
// stays free for client-side routing; Program.cs gains
// `UseStaticFiles` + `MapFallbackToFile`; the Dockerfile becomes
// multi-stage (build React under ClientApp/ → copy dist to wwwroot/
// → run .NET).
//
// Backend-only dotnet (no `ui:`) keeps working unchanged — the
// fullstack branch only fires when `deployable.uiName` is set.
// ---------------------------------------------------------------------------

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const lexErrs = doc.parseResult?.lexerErrors ?? [];
  const parseErrs = doc.parseResult?.parserErrors ?? [];
  const diagErrs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (lexErrs.length || parseErrs.length || diagErrs.length) {
    const lex = lexErrs.map((e) => `LEX ${e.message}`).join("\n");
    const parse = parseErrs.map((e) => `PARSE ${e.message}`).join("\n");
    const diag = diagErrs
      .map((e) => `DIAG ${e.range.start.line + 1}:${e.range.start.character + 1} ${e.message}`)
      .join("\n");
    throw new Error(`parse errors:\n${[lex, parse, diag].filter(Boolean).join("\n")}`);
  }
  return doc.parseResult?.value as Model;
}

const FULLSTACK_SOURCE = `
system FullstackDemo {
  module Sales { context T {
    aggregate Order {
      name: string display
    }
    repository Orders for Order { }
  } }
  ui WebApp { scaffold modules: Sales }
  deployable app { platform: dotnet, modules: Sales, ui: WebApp, port: 8080 }
}
`;

const BACKEND_ONLY_SOURCE = `system BackendOnly {
  module Sales {
    context T {
      aggregate Order {
        name: string display
      }
      repository Orders for Order { }
    }
  }

  deployable app {
    platform: dotnet
    modules: Sales
    port: 8080
  }
}
`;

describe("fullstack dotnet — emits an embedded SPA alongside the API", () => {
  it("generates ClientApp/ next to Program.cs when 'ui:' is declared", async () => {
    const model = await build(FULLSTACK_SOURCE);
    const { files } = generateSystems(model);
    expect(files.has("app/Program.cs")).toBe(true);
    expect(files.has("app/ClientApp/src/main.tsx")).toBe(true);
    expect(files.has("app/ClientApp/package.json")).toBe(true);
    expect(files.has("app/ClientApp/vite.config.ts")).toBe(true);
    expect(files.has("app/ClientApp/index.html")).toBe(true);
  });

  it("wires UseStaticFiles + MapFallbackToFile in Program.cs", async () => {
    const model = await build(FULLSTACK_SOURCE);
    const { files } = generateSystems(model);
    const program = files.get("app/Program.cs")!;
    expect(program).toMatch(/app\.UseDefaultFiles\(\);/);
    expect(program).toMatch(/app\.UseStaticFiles\(\);/);
    expect(program).toMatch(/app\.MapFallbackToFile\("index\.html"\);/);
  });

  it("prefixes controller routes with /api/ to disambiguate from SPA routes", async () => {
    const model = await build(FULLSTACK_SOURCE);
    const { files } = generateSystems(model);
    const controller = files.get("app/Api/OrdersController.cs")!;
    expect(controller).toMatch(/\[Route\("api\/orders"\)\]/);
  });

  it("threads apiBaseUrl: '/api' into the SPA's api/config.ts", async () => {
    const model = await build(FULLSTACK_SOURCE);
    const { files } = generateSystems(model);
    const config = files.get("app/ClientApp/src/api/config.ts")!;
    expect(config).toMatch(/"\/api"/);
  });

  it("uses a multi-stage Dockerfile that builds the SPA and copies dist into wwwroot/", async () => {
    const model = await build(FULLSTACK_SOURCE);
    const { files } = generateSystems(model);
    const dockerfile = files.get("app/Dockerfile")!;
    expect(dockerfile).toMatch(/FROM node:20-alpine AS spa-build/);
    expect(dockerfile).toMatch(/cd ClientApp|WORKDIR \/spa/);
    expect(dockerfile).toMatch(/COPY --from=spa-build \/spa\/dist \.\/wwwroot/);
    expect(dockerfile).toMatch(/COPY --from=dotnet-build \/app\/publish/);
  });

  it("drops files the .NET project owns (Dockerfile / e2e / certs) from ClientApp/", async () => {
    const model = await build(FULLSTACK_SOURCE);
    const { files } = generateSystems(model);
    expect(files.has("app/ClientApp/Dockerfile")).toBe(false);
    expect(files.has("app/ClientApp/.dockerignore")).toBe(false);
    expect(files.has("app/ClientApp/certs/.gitkeep")).toBe(false);
    expect([...files.keys()].some((p) => p.startsWith("app/ClientApp/e2e/"))).toBe(false);
  });
});

describe("fullstack dotnet — backend-only mode stays untouched", () => {
  it("does NOT emit ClientApp/ when 'ui:' is absent", async () => {
    const model = await build(BACKEND_ONLY_SOURCE);
    const { files } = generateSystems(model);
    expect([...files.keys()].some((p) => p.startsWith("app/ClientApp/"))).toBe(false);
  });

  it("does NOT inject the SPA static-files block into Program.cs", async () => {
    const model = await build(BACKEND_ONLY_SOURCE);
    const { files } = generateSystems(model);
    const program = files.get("app/Program.cs")!;
    expect(program).not.toMatch(/UseStaticFiles/);
    expect(program).not.toMatch(/MapFallbackToFile/);
  });

  it("keeps controller routes at the root (no /api/ prefix)", async () => {
    const model = await build(BACKEND_ONLY_SOURCE);
    const { files } = generateSystems(model);
    const controller = files.get("app/Api/OrdersController.cs")!;
    expect(controller).toMatch(/\[Route\("orders"\)\]/);
    expect(controller).not.toMatch(/\[Route\("api\//);
  });

  it("uses the single-stage .NET-only Dockerfile", async () => {
    const model = await build(BACKEND_ONLY_SOURCE);
    const { files } = generateSystems(model);
    const dockerfile = files.get("app/Dockerfile")!;
    expect(dockerfile).not.toMatch(/spa-build/);
    expect(dockerfile).not.toMatch(/wwwroot/);
  });
});
