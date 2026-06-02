import { E2E_FIXTURES_TS } from "../generator/react/index.js";
import { enrichLoomModel } from "../ir/enrich/enrichments.js";
import { lowerModel } from "../ir/lower/lower.js";
import type {
  DeployableIR,
  EnrichedBoundedContextIR,
  EnrichedLoomModel,
  EnrichedSubdomainIR,
  EnrichedSystemIR,
  SystemIR,
} from "../ir/types/loom-ir.js";
import type { MigrationsIR } from "../ir/types/migrations-ir.js";
import type { Model } from "../language/generated/ast.js";
import { platformFor } from "../platform/registry.js";
import { renderDataSourcesMd } from "./datasources.js";
import { renderE2EFile } from "./e2e-render.js";
import { renderC4Model, renderC4SpecJson } from "./likec4.js";
import {
  renderDeploymentDiagram,
  renderDomainDiagram,
  renderErDiagram,
  renderSequenceDiagram,
  renderWorkflowDiagram,
} from "./mermaid.js";
import { buildMigrations } from "./migrations-builder.js";
import {
  memorySnapshotStore,
  type SnapshotStore,
  serializeSnapshot,
  snapshotRelPath,
} from "./snapshot.js";
import { renderTraceabilityArtifacts } from "./traceability.js";
import { renderUIE2EFile } from "./ui-e2e-render.js";
import { renderWireSpec } from "./wire-spec.js";

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

export interface GenerateSystemOptions {
  emitTrace?: boolean;
  /** Source for `.loom/snapshots/<module>.snapshot.json` baselines.  When
   *  omitted, an empty in-memory store is used — every owning module
   *  emits an "Initial" migration.  CLI wires `fsSnapshotStore(outDir)`;
   *  web playground wires its VFS-backed store. */
  snapshots?: SnapshotStore;
}

export function generateSystems(model: Model, options: GenerateSystemOptions = {}): SystemEmission {
  // Lowering produces a faithful AST projection; enrichment populates
  // wireShape, the implicit `findAll` find, and react `moduleNames`
  // inheritance.  See src/ir/enrich/enrichments.ts.
  const loom = enrichLoomModel(lowerModel(model));
  return generateSystemsFromLoom(loom, options);
}

/** Multi-file entry point.  Callers that have already lowered + merged
 *  the per-document `LoomModel`s (the project loader path — one model
 *  per `.ddd` document, then `mergeLoomModels` to fold them) feed the
 *  pre-enriched result here so we don't re-lower.  `generateSystems`
 *  above is the single-document shorthand that still does its own
 *  lower + enrich. */
export function generateSystemsFromLoom(
  loom: EnrichedLoomModel,
  options: GenerateSystemOptions = {},
): SystemEmission {
  const out = new Map<string, string>();
  const snapshots = options.snapshots ?? memorySnapshotStore();
  for (const sys of loom.systems) {
    emitSystem(sys, loom, out, { emitTrace: options.emitTrace, snapshots });
  }
  // Traceability artifacts — model-global (requirements may
  // reference code across systems), so emitted once at the output root
  // rather than per system.  No-op when the source declares no
  // requirement / solution / testCase.
  for (const [path, content] of renderTraceabilityArtifacts(loom)) {
    out.set(path, content);
  }
  return { files: out };
}

function emitSystem(
  sys: EnrichedSystemIR,
  loom: EnrichedLoomModel,
  out: Map<string, string>,
  options: { emitTrace?: boolean; snapshots: SnapshotStore },
): void {
  // Pre-compute a module-name → contexts lookup so a deployable can
  // collect its slice quickly.
  const modulesByName = new Map<string, EnrichedSubdomainIR>();
  for (const m of sys.subdomains) modulesByName.set(m.name, m);

  // Build platform-neutral migration deltas once per system, then write
  // the updated snapshot for every owning module so the next regen has
  // a baseline to diff against.  Modules without an owner are skipped
  // by `buildMigrations` — `migrations` only carries entries for
  // modules where `module.migrationsOwner` is set.
  const migrations = buildMigrations(sys, options.snapshots);
  for (const m of migrations) {
    out.set(snapshotRelPath(m.module), serializeSnapshot(m.next));
  }

  for (const d of sys.deployables) {
    const contexts = collectContextsFor(d, modulesByName);
    const ownedMigrations = migrationsForDeployable(
      d,
      migrations,
      platformFor(d.platform).needsDb,
      sys,
    );
    emitDeployable(sys, d, contexts, out, {
      emitTrace: options.emitTrace,
      migrations: ownedMigrations,
      topLevelComponents: loom.components,
    });
  }

  out.set("docker-compose.yml", renderDockerCompose(sys));
  out.set("db-init/00-create-databases.sql", renderDbInit(sys));
  // Wire-spec artifact — diffable record of every aggregate / part /
  // value object's canonical wire shape.  See `wire-spec.ts`.
  out.set(".loom/wire-spec.json", renderWireSpec(sys));
  // Mermaid views of the IR — a domain class diagram and a per-workflow
  // call flowchart.  The playground previews them inline; GitHub renders
  // them in fences.  See `mermaid.ts`.
  out.set(".loom/domain.mmd", renderDomainDiagram(sys));
  out.set(".loom/workflows.mmd", renderWorkflowDiagram(sys));
  out.set(".loom/er.mmd", renderErDiagram(sys));
  out.set(".loom/sequence.mmd", renderSequenceDiagram(sys));
  out.set(".loom/deployment.mmd", renderDeploymentDiagram(sys));
  // LikeC4 architecture model (https://likec4.dev) — opens in the
  // LikeC4 CLI / VS Code extension.  See `likec4.ts`.  The sibling
  // `.c4.json` is the same model as structured data, which the playground
  // rebuilds (it can't run the Langium parser in-browser) to render the
  // diagram; hidden from the playground's file tree.
  out.set(".loom/architecture.c4", renderC4Model(sys));
  out.set(".loom/architecture.c4.json", renderC4SpecJson(sys));
  // DataSource routing — derived markdown view of how `dataSource`
  // declarations route domain contexts to physical storage.  Pairs
  // with the Phase B / C / D validators.  See `datasources.ts`.
  out.set(".loom/datasources.md", renderDataSourcesMd(sys));

  // E2E test scaffolding — emitted only when the system declares
  // `test e2e` blocks.  Lives at the system root so it can run against
  // the whole compose stack with one `vitest run e2e/`.
  const e2eFile = renderE2EFile(sys, modulesByName);
  if (e2eFile) {
    out.set(`e2e/${sys.name}.e2e.test.ts`, e2eFile);
    out.set("e2e/package.json", E2E_PACKAGE_JSON);
    out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);
  }

  // UI e2e specs — one per deployable that mounts a `ui:` and has
  // any `test e2e ui ... against <this-deployable>` blocks.
  // Consults `PlatformSurface.mountsUi` so any new platform that
  // admits a UI mount (react / static / phoenixLiveView / fullstack
  // dotnet) picks these up without an additional code edit here.
  // Dotnet is dual-mode (mountsUi is `true`, but backend-only dotnet
  // deployables have no `uiName`) — gate on `d.uiName` so we don't
  // call the spec renderer for backend-only deployables; it would
  // return null anyway, but the explicit gate makes the intent
  // unambiguous.  Emitted into the deployable's existing `e2e/`
  // directory next to the auto-generated page objects + smoke spec.
  for (const d of sys.deployables) {
    if (!platformFor(d.platform).mountsUi) continue;
    if (!d.uiName) continue;
    const uiSpec = renderUIE2EFile(sys, modulesByName, d);
    if (uiSpec) {
      const slug = serviceSlug(d.name);
      out.set(`${slug}/e2e/${sys.name}.ui.spec.ts`, uiSpec);
      // Co-locate the console-capture fixture the spec imports
      // (`./fixtures`).  The React generator already emits this for
      // react deployables; emitting it here covers non-react UI mounts
      // (e.g. phoenixLiveView) so the import resolves everywhere.
      out.set(`${slug}/e2e/fixtures.ts`, E2E_FIXTURES_TS);
    }
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
  modulesByName: Map<string, EnrichedSubdomainIR>,
): EnrichedBoundedContextIR[] {
  const want = new Set(d.contextNames);
  const out: EnrichedBoundedContextIR[] = [];
  // An abstract base (aggregate-inheritance.md) is kept in the generation
  // view only when it OWNS a physical table the platform must emit — i.e. a
  // `sharedTable` (TPH) base on the Hono backend, the one backend that
  // implements TPH (v1).  Otherwise it emits nothing of its own (no table /
  // repository / routes) and is stripped here, a single chokepoint:
  //   - `ownTable` (TPC) base, any backend → dropped; each concrete is a
  //     standalone table carrying the merged base fields.
  //   - `sharedTable` (TPH) base on a non-Hono backend → dropped; TPH is
  //     gated as not-implemented there by IR-validate, so it never generates.
  // Concretes always stay; the per-aggregate emit loop skips abstract bases
  // for repo/routes regardless, so a kept TPH base only contributes its table.
  const isHono = d.platform === "node";
  const keepsTable = (a: { isAbstract?: boolean; inheritanceUsing?: string }) =>
    !!a.isAbstract && isHono && (a.inheritanceUsing ?? "sharedTable") === "sharedTable";
  // On Hono, a TPC (`ownTable`) base is also kept in the view — not for a table
  // of its own (the per-aggregate emit loop skips abstract aggregates), but so
  // the base-reader pass can see it and emit the polymorphic `find all <Base>`
  // reader that delegates to the concrete repositories.  Other backends still
  // drop it (no TPC base reader there yet).
  const keepsForBaseReader = (a: { isAbstract?: boolean; inheritanceUsing?: string }) =>
    !!a.isAbstract && isHono && a.inheritanceUsing === "ownTable";
  const dropped = (a: { isAbstract?: boolean; inheritanceUsing?: string }) =>
    !!a.isAbstract && !keepsTable(a) && !keepsForBaseReader(a);
  for (const mod of modulesByName.values()) {
    for (const c of mod.contexts) {
      if (!want.has(c.name)) continue;
      const kept = c.aggregates.filter((a) => !dropped(a));
      out.push(kept.length === c.aggregates.length ? c : { ...c, aggregates: kept });
    }
  }
  return out;
}

function emitDeployable(
  sys: SystemIR,
  d: DeployableIR,
  contexts: EnrichedBoundedContextIR[],
  out: Map<string, string>,
  options: {
    emitTrace?: boolean;
    migrations?: MigrationsIR[];
    topLevelComponents?: import("../ir/types/loom-ir.js").ComponentIR[];
  } = {},
): void {
  const emitTrace = !!options.emitTrace;
  // Per-deployable folder uses a lowercase slug (Docker requires
  // lowercase image names; compose derives images from
  // `<project>-<service>`).  The platform's `emitProject` decides
  // any internal-namespace casing (.NET capitalises for csproj,
  // Hono uses lowercase imports, React uses kebab-/camel- as JSX
  // dictates).
  const sub = serviceSlug(d.name);
  const platform = platformFor(d.platform);
  const files = platform.emitProject({
    contexts,
    deployable: d,
    sys,
    migrations: options.migrations,
    emitTrace,
    topLevelComponents: options.topLevelComponents,
  });
  for (const [relPath, content] of files) {
    out.set(`${sub}/${relPath}`, content);
  }
}

/** Filter system-level migrations to just those this deployable runs.
 *
 *  Every needsDb deployable that hosts any context of a subdomain
 *  receives that subdomain's migrations.  Frontend platforms (no DB)
 *  get nothing — gated upstream by the platform's `needsDb` flag. */
function migrationsForDeployable(
  d: DeployableIR,
  all: MigrationsIR[],
  needsDb: boolean,
  sys: EnrichedSystemIR,
): MigrationsIR[] {
  if (!needsDb) return [];
  const hostedContexts = new Set(d.contextNames);
  const hostedSubdomains = new Set<string>();
  for (const sd of sys.subdomains) {
    if (sd.contexts.some((c) => hostedContexts.has(c.name))) hostedSubdomains.add(sd.name);
  }
  return all.filter((m) => hostedSubdomains.has(m.module));
}

/** A docker-compose-safe slug: lowercase, no characters outside the
 * conservative `[a-z0-9_]` set. */
function serviceSlug(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
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
  // Storage sidecar services for the infrastructure kinds that need a
  // running dev container (object stores, queues).  Gated to the new
  // technologies so postgres-only / pre-Phase-2 models render byte-
  // identically; restApi and the relational/cache/search types emit no
  // sidecar here.
  const sidecars = renderStorageSidecars(sys);
  for (const svc of sidecars.services) {
    lines.push(...svc.map((l) => `  ${l}`));
    lines.push("");
  }
  lines.push("volumes:");
  lines.push("  pgdata: {}");
  for (const v of sidecars.volumes) lines.push(`  ${v}: {}`);
  return lines.join("\n") + "\n";
}

/** Dev-compose sidecar services derived from `sys.storages`.  One per
 *  object-store / queue storage, named by its slug; returns the service
 *  blocks (each a string[] of lines) and any named volumes they need. */
function renderStorageSidecars(sys: SystemIR): { services: string[][]; volumes: string[] } {
  const services: string[][] = [];
  const volumes: string[] = [];
  for (const s of sys.storages) {
    const slug = serviceSlug(s.name);
    if (s.type === "s3") {
      const volume = `${slug}-data`;
      volumes.push(volume);
      services.push([
        `${slug}:`,
        `  image: minio/minio:latest`,
        `  command: server /data --console-address ":9001"`,
        `  environment:`,
        `    MINIO_ROOT_USER: minioadmin`,
        `    MINIO_ROOT_PASSWORD: minioadmin`,
        `  volumes:`,
        `    - ${volume}:/data`,
      ]);
    } else if (s.type === "rabbitmq") {
      services.push([
        `${slug}:`,
        `  image: rabbitmq:3-management`,
        `  environment:`,
        `    RABBITMQ_DEFAULT_USER: guest`,
        `    RABBITMQ_DEFAULT_PASS: guest`,
      ]);
    }
  }
  return { services, volumes };
}

/** Postgres `docker-entrypoint-initdb.d` script: one DATABASE per
 * deployable that needs one.  Postgres only runs the init dir on
 * the first boot of an empty data volume; this is exactly what we
 * want for dev compose. */
function renderDbInit(sys: SystemIR): string {
  const lines: string[] = ["-- Auto-generated."];
  for (const d of sys.deployables) {
    if (!platformFor(d.platform).needsDb) continue;
    const slug = serviceSlug(d.name);
    lines.push(`CREATE DATABASE ${slug};`);
  }
  return lines.join("\n") + "\n";
}

function renderDeployableService(d: DeployableIR, sys: SystemIR): string[] {
  const slug = serviceSlug(d.name);
  const platform = platformFor(d.platform);
  const shape = platform.composeService({ deployable: d, sys, slug });
  const lines: string[] = [];
  lines.push(`${slug}:`);
  lines.push(`  build: ./${slug}`);
  if (shape.dependsOnDb) {
    lines.push(`  depends_on:`);
    lines.push(`    db:`);
    lines.push(`      condition: service_healthy`);
  }
  lines.push(`  environment:`);
  for (const [k, v] of shape.env) lines.push(`    ${k}: ${JSON.stringify(v)}`);
  lines.push(`  ports:`);
  lines.push(`    - "${d.port}:${shape.internalPort}"`);
  // The healthcheck command runs *inside* the container, so it
  // targets `internalPort` (where the service listens), not `d.port`
  // (the external host mapping).  The two often differ — e.g. when a
  // second .NET deployable picks an alternate host port to avoid
  // colliding with the first.  Without this comment a reader scanning
  // `8081:8080` then `localhost:8080` does a double-take.
  lines.push(`  healthcheck:`);
  lines.push(
    `    test: ["CMD-SHELL", "wget -qO- http://localhost:${shape.internalPort}${shape.healthPath} || exit 1"]`,
  );
  lines.push(`    interval: 5s`);
  lines.push(`    timeout: 3s`);
  lines.push(`    retries: 10`);
  return lines;
}
