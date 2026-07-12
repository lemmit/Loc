import { describe, expect, it } from "vitest";
import { DOTNET_TFM } from "../../src/generator/dotnet/emit/program.js";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M26 — `.vscode/launch.json` fan-out across every debuggable backend
// (node/coreclr/java) via `PlatformSurface.debugLaunch()`. `docs/plans/
// dap-node-debug.md` is the design record; `src/system/launch-config.ts` is
// the renderer under test indirectly (through `generateSystems`).
// ---------------------------------------------------------------------------

// Deployable names run through `serviceSlug` (camelCase -> snake_case,
// src/system/index.ts) before becoming the output path prefix / launch
// config `cwd`/`program` slug.
const SLUG_FOR: Record<string, string> = {
  node: "hono_api",
  dotnet: "dotnet_api",
  java: "java_api",
};

const THREE_BACKEND_SOURCE = `
system Debug {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
      }
      repository Orders for Order {}
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  api OrdersApi from Sales
  deployable honoApi   { platform: node   contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 3000 }
  deployable dotnetApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 8080 }
  deployable javaApi   { platform: java   contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 8081 }
}
`;

const NO_DEBUGGABLE_BACKEND_SOURCE = `
system Debug2 {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
      }
      repository Orders for Order {}
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  api OrdersApi from Sales
  ui SalesUi with scaffold(subdomains: [Sales]) { }
  deployable pyApi      { platform: python contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 8000 }
  deployable phoenixApi { platform: elixir contexts: [Orders] dataSources: [ordersState] ui: SalesUi port: 4000 }
  deployable webApp     { platform: react targets: pyApi ui: SalesUi port: 3001 }
}
`;

async function filesFor(
  src: string,
  options: { sourcemap?: boolean } = {},
): Promise<Map<string, string>> {
  const model = await parseValid(src);
  return generateSystems(model, options).files;
}

function findFile(files: Map<string, string>, suffix: string): string {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix} among:\n${[...files.keys()].join("\n")}`);
}

describe(".vscode/launch.json", () => {
  it("is absent without --sourcemap", async () => {
    const files = await filesFor(THREE_BACKEND_SOURCE);
    expect(files.has(".vscode/launch.json")).toBe(false);
  });

  it("is absent when every deployable's platform has no debugLaunch (python/elixir/frontend)", async () => {
    const files = await filesFor(NO_DEBUGGABLE_BACKEND_SOURCE, { sourcemap: true });
    expect(files.has(".vscode/launch.json")).toBe(false);
  });

  it("emits one configuration per debuggable deployable, in deployable order", async () => {
    const files = await filesFor(THREE_BACKEND_SOURCE, { sourcemap: true });
    const launchJson = JSON.parse(findFile(files, ".vscode/launch.json")) as {
      version: string;
      configurations: Array<Record<string, unknown>>;
    };
    expect(launchJson.version).toBe("0.2.0");
    expect(launchJson.configurations).toHaveLength(3);
    const [nodeCfg, dotnetCfg, javaCfg] = launchJson.configurations;
    expect(nodeCfg!.type).toBe("node");
    expect(nodeCfg!.name).toBe("Debug honoApi (node --enable-source-maps)");
    expect(dotnetCfg!.type).toBe("coreclr");
    expect(dotnetCfg!.name).toBe("Debug dotnetApi (.NET)");
    expect(javaCfg!.type).toBe("java");
    expect(javaCfg!.name).toBe("Debug javaApi (Java)");
  });

  it("node config is byte-identical to the pre-M26 shape (refactor pin)", async () => {
    const files = await filesFor(THREE_BACKEND_SOURCE, { sourcemap: true });
    const launchJson = JSON.parse(findFile(files, ".vscode/launch.json")) as {
      configurations: Array<Record<string, unknown>>;
    };
    const nodeCfg = launchJson.configurations[0];
    const slug = SLUG_FOR.node;
    expect(nodeCfg).toEqual({
      type: "node",
      request: "launch",
      name: "Debug honoApi (node --enable-source-maps)",
      program: `\${workspaceFolder}/${slug}/index.ts`,
      cwd: `\${workspaceFolder}/${slug}`,
      runtimeArgs: ["--enable-source-maps"],
      outFiles: [`\${workspaceFolder}/${slug}/**/*.ts`],
      resolveSourceMapLocations: [`\${workspaceFolder}/${slug}/**`, "!**/node_modules/**"],
      skipFiles: ["<node_internals>/**"],
      console: "integratedTerminal",
    });
  });

  it("coreclr program path names the SAME assembly the emitted .csproj does", async () => {
    const files = await filesFor(THREE_BACKEND_SOURCE, { sourcemap: true });
    const slug = SLUG_FOR.dotnet;
    // Find the deployable's own project file — `<slug>/<Assembly>.csproj` —
    // and derive the expected assembly name from ITS basename (the #1748
    // no-hardcode pattern), rather than re-deriving pascal-casing here.
    const csprojPath = [...files.keys()].find(
      (p) => p.startsWith(`${slug}/`) && p.endsWith(".csproj") && !p.includes("Tests/"),
    );
    expect(csprojPath, `no csproj under ${slug}/`).toBeDefined();
    const assembly = csprojPath!.slice(slug.length + 1, -".csproj".length);

    const launchJson = JSON.parse(findFile(files, ".vscode/launch.json")) as {
      configurations: Array<Record<string, unknown>>;
    };
    const dotnetCfg = launchJson.configurations[1] as { program: string; cwd: string };
    expect(dotnetCfg.program).toBe(
      `\${workspaceFolder}/${slug}/bin/Debug/${DOTNET_TFM}/${assembly}.dll`,
    );
    expect(dotnetCfg.cwd).toBe(`\${workspaceFolder}/${slug}`);
  });

  it("java mainClass/projectName match the emitted Application.java package + gradle settings artifactId", async () => {
    const files = await filesFor(THREE_BACKEND_SOURCE, { sourcemap: true });
    const slug = SLUG_FOR.java;

    const appPath = [...files.keys()].find(
      (p) => p.startsWith(`${slug}/`) && p.endsWith("Application.java"),
    );
    expect(appPath, `no Application.java under ${slug}/`).toBeDefined();
    const appContent = files.get(appPath!)!;
    const pkgMatch = /^package\s+([\w.]+);/m.exec(appContent);
    expect(pkgMatch, "Application.java has no package declaration").not.toBeNull();
    const pkg = pkgMatch![1];

    const settingsPath = [...files.keys()].find(
      (p) =>
        p.startsWith(`${slug}/`) && /^settings\.gradle(\.kts)?$/.test(p.slice(slug.length + 1)),
    );
    expect(settingsPath, `no settings.gradle(.kts) under ${slug}/`).toBeDefined();
    const settingsContent = files.get(settingsPath!)!;
    const artifactMatch = /rootProject\.name\s*=\s*"([^"]+)"/.exec(settingsContent);
    expect(artifactMatch, "settings.gradle has no rootProject.name").not.toBeNull();
    const artifactId = artifactMatch![1];

    const launchJson = JSON.parse(findFile(files, ".vscode/launch.json")) as {
      configurations: Array<Record<string, unknown>>;
    };
    const javaCfg = launchJson.configurations[2] as {
      mainClass: string;
      projectName: string;
      cwd: string;
    };
    expect(javaCfg.mainClass).toBe(`${pkg}.Application`);
    expect(javaCfg.projectName).toBe(artifactId);
    expect(javaCfg.cwd).toBe(`\${workspaceFolder}/${slug}`);
  });
});
