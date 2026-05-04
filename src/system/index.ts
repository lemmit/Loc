import type { Model } from "../language/generated/ast.js";
import { lowerModel } from "../ir/lower.js";
import type {
  BoundedContextIR,
  DeployableIR,
  LoomModel,
  ModuleIR,
  Platform,
  SystemIR,
} from "../ir/loom-ir.js";
import {
  generateDotnetForContexts,
} from "../generator/dotnet/index.js";
import {
  generateTypeScriptForContexts,
} from "../generator/typescript/index.js";
import { generateReactForContexts } from "../generator/react/index.js";
import { renderE2EFile } from "./e2e-render.js";

// ---------------------------------------------------------------------------
// System-mode generation.
//
// A `.ddd` source can declare one or more `system` blocks; each system
// owns a deployment plan: modules grouping bounded contexts, plus
// deployable artefacts that pick a platform and a subset of modules.
//
// The output for a system is a directory tree:
//
//     <outdir>/
//        <deployable-1>/                # full project per deployable
//        <deployable-2>/
//        docker-compose.yml             # wires deployables + a postgres
//
// Each deployable's project is produced by the existing TS or .NET
// pipeline against just its module subset, but everything is colocated
// for a single `docker compose up` workflow.
// ---------------------------------------------------------------------------

export interface SystemEmission {
  /** path → file content, relative to the system output directory. */
  files: Map<string, string>;
}

export function generateSystems(model: Model): SystemEmission {
  const loom = lowerModel(model);
  const out = new Map<string, string>();
  for (const sys of loom.systems) {
    emitSystem(sys, loom, out);
  }
  return { files: out };
}

function emitSystem(
  sys: SystemIR,
  _loom: LoomModel,
  out: Map<string, string>,
): void {
  // Pre-compute a module-name → contexts lookup so a deployable can
  // collect its slice quickly.
  const modulesByName = new Map<string, ModuleIR>();
  for (const m of sys.modules) modulesByName.set(m.name, m);

  for (const d of sys.deployables) {
    const contexts = collectContextsFor(d, modulesByName);
    emitDeployable(sys, d, contexts, out);
  }

  out.set("docker-compose.yml", renderDockerCompose(sys));
  out.set("db-init/00-create-databases.sql", renderDbInit(sys));

  // E2E test scaffolding — emitted only when the system declares
  // `test e2e` blocks.  Lives at the system root so it can run against
  // the whole compose stack with one `vitest run e2e/`.
  const e2eFile = renderE2EFile(sys, modulesByName);
  if (e2eFile) {
    out.set(`e2e/${sys.name}.e2e.test.ts`, e2eFile);
    out.set("e2e/package.json", E2E_PACKAGE_JSON);
    out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);
  }
}

const E2E_PACKAGE_JSON =
  JSON.stringify(
    {
      name: "loom-e2e",
      version: "0.0.0",
      type: "module",
      private: true,
      scripts: { test: "vitest run" },
      devDependencies: {
        typescript: "^5.7.0",
        vitest: "^2.1.0",
      },
    },
    null,
    2,
  ) + "\n";

const E2E_TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node", "vitest/globals"],
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  ) + "\n";

function collectContextsFor(
  d: DeployableIR,
  modulesByName: Map<string, ModuleIR>,
): BoundedContextIR[] {
  const out: BoundedContextIR[] = [];
  for (const name of d.moduleNames) {
    const mod = modulesByName.get(name);
    if (!mod) continue;
    out.push(...mod.contexts);
  }
  return out;
}

function emitDeployable(
  sys: SystemIR,
  d: DeployableIR,
  contexts: BoundedContextIR[],
  out: Map<string, string>,
): void {
  // Folder + compose service name use a lowercase slug (Docker requires
  // lowercase image names; compose derives images from `<project>-<service>`).
  // The .NET namespace and CSPROJ name use the capitalised form so code
  // looks idiomatic.
  const sub = serviceSlug(d.name);
  const namespace = capitalize(d.name);
  const files =
    d.platform === "dotnet"
      ? generateDotnetForContexts(contexts, namespace)
      : d.platform === "hono"
        ? generateTypeScriptForContexts(contexts)
        : generateReactForContexts(contexts, sys, d);
  for (const [relPath, content] of files) {
    out.set(`${sub}/${relPath}`, content);
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** A docker-compose-safe slug: lowercase, no characters outside the
 * conservative `[a-z0-9_]` set. */
function serviceSlug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// docker-compose.yml
// ---------------------------------------------------------------------------

function renderDockerCompose(sys: SystemIR): string {
  const lines: string[] = [];
  lines.push("# Auto-generated.");
  lines.push("services:");
  lines.push("  db:");
  lines.push("    image: postgres:16-alpine");
  lines.push("    environment:");
  lines.push("      POSTGRES_DB: postgres");
  lines.push("      POSTGRES_USER: postgres");
  lines.push("      POSTGRES_PASSWORD: postgres");
  lines.push("    volumes:");
  lines.push("      - pgdata:/var/lib/postgresql/data");
  // Per-deployable databases keep each service's schema isolated.
  // EF Core's EnsureCreated is all-or-nothing per database, so two
  // .NET deployables sharing a DB race: the first to start creates
  // its tables, the second sees existing tables and creates nothing.
  // The init script runs once on first boot of an empty pgdata
  // volume; on a fresh `up`, every deployable owns its own DB.
  lines.push("      - ./db-init:/docker-entrypoint-initdb.d:ro");
  lines.push("    healthcheck:");
  lines.push('      test: ["CMD", "pg_isready", "-U", "postgres"]');
  lines.push("      interval: 5s");
  lines.push("      timeout: 5s");
  lines.push("      retries: 10");
  lines.push("");
  for (const d of sys.deployables) {
    lines.push(...renderDeployableService(d, sys).map((l) => `  ${l}`));
    lines.push("");
  }
  lines.push("volumes:");
  lines.push("  pgdata: {}");
  return lines.join("\n") + "\n";
}

/** Postgres `docker-entrypoint-initdb.d` script: one DATABASE per
 * deployable.  Postgres only runs the init dir on the first boot of
 * an empty data volume; this is exactly what we want for dev compose. */
function renderDbInit(sys: SystemIR): string {
  const lines: string[] = ["-- Auto-generated."];
  for (const d of sys.deployables) {
    if (!deployableNeedsDb(d)) continue;
    const slug = serviceSlug(d.name);
    lines.push(`CREATE DATABASE ${slug};`);
  }
  return lines.join("\n") + "\n";
}

function renderDeployableService(d: DeployableIR, sys: SystemIR): string[] {
  const slug = serviceSlug(d.name);
  const internal = d.platform === "dotnet" ? 8080 : 3000;
  const env = envForPlatform(d, sys, slug);
  const lines: string[] = [];
  lines.push(`${slug}:`);
  lines.push(`  build: ./${slug}`);
  if (d.platform !== "react") {
    lines.push(`  depends_on:`);
    lines.push(`    db:`);
    lines.push(`      condition: service_healthy`);
  }
  lines.push(`  environment:`);
  for (const [k, v] of env) lines.push(`    ${k}: ${JSON.stringify(v)}`);
  lines.push(`  ports:`);
  lines.push(`    - "${d.port}:${internal}"`);
  // React healthcheck: any 200 from `/` is enough; the SPA shell loads
  // even before a backend is up.
  const healthPath = d.platform === "react" ? "/" : "/health";
  lines.push(`  healthcheck:`);
  lines.push(
    `    test: ["CMD-SHELL", "wget -qO- http://localhost:${internal}${healthPath} || exit 1"]`,
  );
  lines.push(`    interval: 5s`);
  lines.push(`    timeout: 3s`);
  lines.push(`    retries: 10`);
  return lines;
}

function envForPlatform(
  d: DeployableIR,
  sys: SystemIR,
  database: string,
): Array<[string, string]> {
  if (d.platform === "dotnet") {
    return [
      [
        "ConnectionStrings__Default",
        `Host=db;Port=5432;Database=${database};Username=postgres;Password=postgres`,
      ],
    ];
  }
  if (d.platform === "react") {
    const target = sys.deployables.find((t) => t.name === d.targetName);
    return [
      [
        "VITE_API_BASE_URL",
        `http://localhost:${target?.port ?? 8080}`,
      ],
    ];
  }
  return [
    ["DATABASE_URL", `postgres://postgres:postgres@db:5432/${database}`],
  ];
}

// Avoid emitting a postgres database for frontend deployables that
// don't connect to one.
function deployableNeedsDb(d: DeployableIR): boolean {
  return d.platform !== "react";
}
