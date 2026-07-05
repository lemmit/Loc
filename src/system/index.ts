import { SourceMapRecorder } from "../generator/_trace/sourcemap.js";
import { E2E_FIXTURES_TS } from "../generator/react/emit-templates.js";
import { enrichLoomModel } from "../ir/enrich/enrichments.js";
import { lowerModel } from "../ir/lower/lower.js";
import type {
  DeployableIR,
  EnrichedBoundedContextIR,
  EnrichedLoomModel,
  EnrichedSubdomainIR,
  EnrichedSystemIR,
  Platform,
  SystemIR,
} from "../ir/types/loom-ir.js";
import type { MigrationsIR } from "../ir/types/migrations-ir.js";
import type { Model } from "../language/generated/ast.js";
import { platformFor } from "../platform/registry.js";
import { hasAdapters, resolveLayout, resolveStyle } from "../platform/resolve-adapters.js";
import { AUTH_BASE_PATH } from "../util/api-base.js";
import { renderAsyncApi } from "./asyncapi.js";
import { renderDataSourcesMd } from "./datasources.js";
import { renderE2EFile } from "./e2e-render.js";
import { renderHelmChart } from "./helm.js";
import { renderKubernetesManifests } from "./kubernetes.js";
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
import { renderSourceMap } from "./sourcemap.js";
import { renderSourceMapV3 } from "./sourcemap-v3.js";
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
  /** When true, additionally emit a Helm chart (`helm/`) and the raw
   *  manifests it renders to (`k8s/`) ALONGSIDE the always-present
   *  `docker-compose.yml`.  Opt-in (the CLI `--k8s` flag); off keeps the
   *  output the inner-loop compose stack only.  See docs/kubernetes.md. */
  emitKubernetes?: boolean;
  /** Source for `.loom/snapshots/<module>.snapshot.json` baselines.  When
   *  omitted, an empty in-memory store is used — every owning module
   *  emits an "Initial" migration.  CLI wires `fsSnapshotStore(outDir)`;
   *  web playground wires its VFS-backed store. */
  snapshots?: SnapshotStore;
  /** Allow destructive migration deltas (drops / narrowing type changes /
   *  NOT-NULL column adds without a default on an existing table).  Off by
   *  default: such a delta throws `MigrationDestructiveError` so the
   *  operator applies it deliberately (the CLI `--allow-destructive`
   *  flag).  See docs/migrations.md § Destructive changes. */
  allowDestructive?: boolean;
  /** `--sourcemap` switch — when true, additionally emit
   *  `.loom/sourcemap.json` mapping generated file regions back to the
   *  `.ddd` spans (or macro-call sites) that produced them.  Off by
   *  default so byte-identical output is preserved for every existing
   *  fixture/gate.  See docs/plans/source-map-debug-kickoff.md. */
  sourcemap?: boolean;
  /** `.ddd` source text for every path an `OriginRef` can resolve to
   *  (`SourceRef.path` — a Langium `URI.path`), keyed the same way.  Feeds
   *  Source Map v3 sidecar emission (`<file>.ts.map` + a trailing
   *  `sourceMappingURL` directive) for the node/Hono backend's `.ts`/`.tsx`
   *  output — the only files a JS/TS debugger can step through today.
   *  `src/system/` stays browser-safe (no `fs`), so the CLI/playground
   *  supply the text; a mapped file with no entry here is skipped (no
   *  sidecar), never guessed.  No effect unless `sourcemap` is also true.
   *  See docs/proposals/source-map-and-debugging.md §8. */
  sourceTexts?: ReadonlyMap<string, string>;
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
  // One recorder for the whole model — systems share one flat output map
  // (same pattern as traceability below), so a single recorder's paths
  // line up with the final written paths across every system.
  const recorder = options.sourcemap ? SourceMapRecorder.create() : undefined;
  for (const sys of loom.systems) {
    emitSystem(sys, loom, out, {
      emitTrace: options.emitTrace,
      emitKubernetes: options.emitKubernetes,
      snapshots,
      allowDestructive: options.allowDestructive,
      sourcemap: recorder,
    });
  }
  // Traceability artifacts — model-global (requirements may
  // reference code across systems), so emitted once at the output root
  // rather than per system.  No-op when the source declares no
  // requirement / solution / testCase.
  for (const [path, content] of renderTraceabilityArtifacts(loom)) {
    out.set(path, content);
  }
  if (recorder) out.set(".loom/sourcemap.json", renderSourceMap(recorder));
  // Source Map v3 sidecars — additive on top of `.loom/sourcemap.json`
  // (proposal §8), scoped to the node/Hono backend's `.ts`/`.tsx` output
  // (see `sourceTexts`' doc comment).  Skipped entirely without
  // `sourceTexts` — never emitted with a guessed `sourcesContent`.
  if (recorder && options.sourceTexts) {
    for (const [path, regions] of recorder.entries()) {
      if (!(path.endsWith(".ts") || path.endsWith(".tsx"))) continue;
      const content = out.get(path);
      if (content === undefined) continue;
      const rendered = renderSourceMapV3(regions, path, options.sourceTexts);
      if (!rendered) continue;
      const mapPath = `${path}.map`;
      out.set(mapPath, rendered);
      // Appending AFTER recording is safe — the recorder already captured
      // every region's line numbers against the file's pre-directive
      // content, and this is the file's own only trailing-line addition.
      const basename = mapPath.split("/").pop()!;
      out.set(path, `${content}//# sourceMappingURL=${basename}\n`);
    }
  }
  return { files: out };
}

function emitSystem(
  sys: EnrichedSystemIR,
  loom: EnrichedLoomModel,
  out: Map<string, string>,
  options: {
    emitTrace?: boolean;
    emitKubernetes?: boolean;
    snapshots: SnapshotStore;
    allowDestructive?: boolean;
    sourcemap?: SourceMapRecorder;
  },
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
  const migrations = buildMigrations(sys, options.snapshots, {
    allowDestructive: options.allowDestructive,
  });
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
      sourcemap: options.sourcemap,
    });
  }

  out.set("docker-compose.yml", renderDockerCompose(sys));
  out.set("db-init/00-create-databases.sql", renderDbInit(sys));
  // Opt-in production deployment artifacts (D-K8S-*; docs/kubernetes.md).
  // Emitted ALONGSIDE compose, never instead of it: compose stays the
  // inner-loop story, the chart + raw manifests are the cluster story.
  if (options.emitKubernetes) {
    for (const [path, content] of renderHelmChart(sys)) out.set(path, content);
    for (const [path, content] of renderKubernetesManifests(sys)) out.set(path, content);
  }
  // Bundled dev Keycloak realm import (D-AUTH-OIDC §4.2) — loaded by the
  // compose `keycloak` service's `--import-realm` on first boot.
  if (bundlesKeycloak(sys)) out.set("keycloak/realm.json", renderKeycloakRealm(sys));
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
  // AsyncAPI view of `channel` declarations (channels.md, Slice 1).
  // Realises the BC-model's "events as channels" placeholder.
  out.set(".loom/asyncapi.yaml", renderAsyncApi(sys));

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
        typescript: "^6.0.0",
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
  //   - `ownTable` (TPC) base, any backend → kept for the base-reader pass
  //     (see keepsForBaseReader); it contributes no table of its own, but is
  //     the read home for `find all <Base>`.
  //   - `sharedTable` (TPH) base on a non-TPH-capable backend → dropped; TPH
  //     is gated as not-implemented there by IR-validate, so it never generates.
  // Concretes always stay; the per-aggregate emit loop skips abstract bases
  // for repo/routes regardless, so a kept TPH base only contributes its table.
  // TPH storage is implemented on Hono (Drizzle shared table), .NET (EF Core
  // `HasDiscriminator`), Phoenix (Ecto shared table with a `kind` discriminator
  // column), Python, and Java (JPA SINGLE_TABLE); all keep
  // the base so it can own the shared table.
  const isTphCapable =
    d.platform === "node" ||
    d.platform === "dotnet" ||
    d.platform === "elixir" ||
    d.platform === "python" ||
    d.platform === "java";
  const keepsTable = (a: { isAbstract?: boolean; inheritanceUsing?: string }) =>
    !!a.isAbstract && isTphCapable && (a.inheritanceUsing ?? "sharedTable") === "sharedTable";
  // A TPC (`ownTable`) base is kept in the view on every backend that
  // implements the polymorphic read home — not for a table of its own (the
  // per-aggregate emit loop skips abstract aggregates), but so the base-reader
  // pass can see it and emit `find all <Base>`: Hono delegates to the concrete
  // Drizzle repositories, .NET to the concrete EF repositories (returning the
  // abstract-base union type), Phoenix to the concrete Ecto reads.  Frontend
  // platforms never host a context, so they never reach here.
  const keepsForBaseReader = (a: { isAbstract?: boolean; inheritanceUsing?: string }) =>
    !!a.isAbstract && a.inheritanceUsing === "ownTable";
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
    sourcemap?: SourceMapRecorder;
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
  // Resolve the EMITTER surface by the fully-qualified `platformRef`
  // (`node@v4` / `node@v5`) so a backend version pin selects the right
  // dep-pin set.  Family-level facts (`needsDb`, adapters) stay keyed on
  // `d.platform` — they're version-independent.  (Before multiple node
  // versions existed, family→default coincided with the only version.)
  const platform = platformFor(d.platformRef as Platform);
  // D-REALIZATION-AXES (Phase 4): resolve the deployable's `application:`
  // (→ style) and `directoryLayout:` (→ layout) selections to concrete
  // adapters HERE — the system layer is the one allowed to import
  // `resolve-adapters` (generators must not reach into `src/platform/`).
  // The resolved adapters thread down through `emitProject` into each
  // backend's `EmitCtx`.  Backends only (`hasAdapters`); frontends carry
  // no axes, so both stay undefined.  Under today's size-1 real menus the
  // resolved adapter is the backend's existing default → byte-identical.
  const resolvedStyle = hasAdapters(d.platform)
    ? resolveStyle(d.platform, d.application)
    : undefined;
  const resolvedLayout = hasAdapters(d.platform)
    ? resolveLayout(d.platform, d.directoryLayout)
    : undefined;
  const files = platform.emitProject({
    contexts,
    deployable: d,
    sys,
    migrations: options.migrations,
    emitTrace,
    topLevelComponents: options.topLevelComponents,
    styleAdapter: resolvedStyle,
    layoutAdapter: resolvedLayout,
    // Scoped so paths the platform records land pre-prefixed with `sub`,
    // matching the final written path exactly (see the loop below).
    sourcemap: options.sourcemap?.scope(sub),
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
/** The browser origins the system's frontend deployables are served from
 *  (compose host ports) — the CORS allowlist for every backend service. */
function frontendOrigins(sys: SystemIR): string[] {
  return sys.deployables
    .filter((f) => platformFor(f.platform).isFrontend)
    .map((f) => `http://localhost:${f.port}`);
}

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
  lines.push("    image: postgres:18-alpine");
  lines.push("    environment:");
  lines.push("      POSTGRES_DB: postgres");
  lines.push("      POSTGRES_USER: postgres");
  lines.push("      POSTGRES_PASSWORD: postgres");
  // postgres:18 moved the default PGDATA to /var/lib/postgresql/18/docker
  // (and the declared VOLUME to /var/lib/postgresql). Pin it back to the
  // legacy path so the named `pgdata` mount below keeps holding the data.
  lines.push("      PGDATA: /var/lib/postgresql/data");
  lines.push("    volumes:");
  // postgres:18+ stores data in a major-version subdirectory and wants the
  // volume mounted at /var/lib/postgresql (NOT .../data) — mounting the old
  // /data path makes the 18 image refuse to start ("PostgreSQL data in
  // /var/lib/postgresql/data (unused mount/volume)").  See docker-library/postgres#1259.
  lines.push("      - pgdata:/var/lib/postgresql");
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
  // Bundled dev IdP (D-AUTH-OIDC §4.2): a Keycloak with a pre-provisioned
  // realm + seeded demo user, so `docker compose up` logs in out of the
  // box.  Production repoints OIDC_ISSUER at a real IdP.
  if (bundlesKeycloak(sys)) {
    lines.push(...renderKeycloakService(sys).map((l) => `  ${l}`));
    lines.push("");
  }
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

// ---------------------------------------------------------------------------
// Bundled dev Keycloak (D-AUTH-OIDC §4.2 — the zero-config quick-start).
// Added when the system declares an OIDC `auth { … }` block whose provider is
// self-hosted (keycloak / custom / a raw `oidc { issuer }`); hosted presets
// (google / auth0 / …) use their own IdP and get no bundled service.
// ---------------------------------------------------------------------------

/** Host port the bundled Keycloak is published on.  Starts at 8081 (8080 is
 *  left for backends) but skips any port a deployable already publishes: the
 *  Java backend's default port is also 8081, so a system with auth + a Java
 *  backend would otherwise map both services to host 8081 and `docker compose
 *  up` fails to bind ("port is already allocated").  Scanning the deployable
 *  ports keeps Keycloak on the first free port regardless of backend mix. */
function keycloakHostPort(sys: SystemIR): number {
  const used = new Set(sys.deployables.map((d) => d.port));
  let port = 8081;
  while (used.has(port)) port++;
  return port;
}

function bundlesKeycloak(sys: SystemIR): boolean {
  const a = sys.auth;
  if (!a) return false;
  return !a.provider || a.provider === "keycloak" || a.provider === "custom";
}

/** Realm + client identifiers + the issuer URL the bundled Keycloak serves.
 *  The issuer uses `host.docker.internal` so the browser (redirects) and the
 *  backend (JWKS / token exchange) resolve the SAME issuer URL — avoiding the
 *  classic Docker localhost-vs-service-name issuer mismatch. */
function keycloakConfig(sys: SystemIR): {
  realm: string;
  clientId: string;
  issuer: string;
  hostPort: number;
} {
  const realm = serviceSlug(sys.name) || "loom";
  const hostPort = keycloakHostPort(sys);
  return {
    realm,
    clientId: `${realm}-app`,
    issuer: `http://host.docker.internal:${hostPort}/realms/${realm}`,
    hostPort,
  };
}

function renderKeycloakService(sys: SystemIR): string[] {
  const hostPort = keycloakHostPort(sys);
  return [
    "keycloak:",
    "  image: quay.io/keycloak/keycloak:26.0",
    '  command: ["start-dev", "--import-realm"]',
    "  environment:",
    "    KC_BOOTSTRAP_ADMIN_USERNAME: admin",
    "    KC_BOOTSTRAP_ADMIN_PASSWORD: admin",
    // KC_HOSTNAME pins the issuer/endpoint URLs Keycloak advertises in its
    // discovery doc to the host-reachable address (see keycloakConfig).
    `    KC_HOSTNAME: http://host.docker.internal:${hostPort}`,
    '    KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true"',
    "  ports:",
    `    - "${hostPort}:8080"`,
    "  volumes:",
    "    - ./keycloak:/opt/keycloak/data/import:ro",
    "  extra_hosts:",
    '    - "host.docker.internal:host-gateway"',
  ];
}

/** Keycloak realm-import JSON: a public client (wildcard localhost redirect
 *  URIs for dev) + a seeded `demo`/`demo` user with a `user` realm role.
 *  Mounted read-only into the container's import dir; `--import-realm` loads
 *  it on first boot. */
function renderKeycloakRealm(sys: SystemIR): string {
  const { realm, clientId } = keycloakConfig(sys);
  // When the auth block declares a literal `audience:`, the generated
  // verifiers VALIDATE it (jose `jwtVerify({ audience })`, .NET
  // `ValidateAudience`, ...) — so the dev realm must mint tokens that
  // carry it, or every password-grant/redirect token 401s out of the
  // box (Keycloak's default `aud` is `account`).  An audience protocol
  // mapper on the client injects the declared value into access tokens.
  const audience = sys.auth?.oidc.audience;
  const audienceMappers =
    audience?.kind === "literal"
      ? [
          {
            name: "loom-declared-audience",
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            consentRequired: false,
            config: {
              "included.custom.audience": audience.value,
              "access.token.claim": "true",
              "id.token.claim": "false",
            },
          },
        ]
      : [];
  const doc = {
    realm,
    enabled: true,
    sslRequired: "none",
    roles: { realm: [{ name: "user" }, { name: "agent" }, { name: "admin" }] },
    clients: [
      {
        clientId,
        enabled: true,
        publicClient: true,
        standardFlowEnabled: true,
        // Dev realm: allow the password grant so tokens can be scripted
        // (tests / curl) without driving the browser redirect flow.
        directAccessGrantsEnabled: true,
        redirectUris: ["http://localhost:*", "http://127.0.0.1:*"],
        webOrigins: ["*"],
        ...(audienceMappers.length > 0 ? { protocolMappers: audienceMappers } : {}),
      },
    ],
    users: [
      {
        username: "demo",
        enabled: true,
        email: "demo@example.com",
        firstName: "Demo",
        lastName: "User",
        emailVerified: true,
        credentials: [{ type: "password", value: "demo", temporary: false }],
        realmRoles: ["user", "agent"],
      },
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
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
  // Point an `auth: required` backend at the bundled dev Keycloak
  // (D-AUTH-OIDC §4.2).  These env vars satisfy the OIDC verifier's
  // `env(...)`-bound issuer/client; production overrides them.
  const oidc = !!(d.auth?.required && bundlesKeycloak(sys));
  const lines: string[] = [];
  lines.push(`${slug}:`);
  lines.push(`  build: ./${slug}`);
  if (shape.dependsOnDb || oidc) {
    lines.push(`  depends_on:`);
    if (shape.dependsOnDb) {
      lines.push(`    db:`);
      lines.push(`      condition: service_healthy`);
    }
    if (oidc) {
      lines.push(`    keycloak:`);
      lines.push(`      condition: service_started`);
    }
  }
  if (oidc) {
    // The backend reaches Keycloak (JWKS / token exchange) via the same
    // host-reachable address the browser uses for redirects.
    lines.push(`  extra_hosts:`);
    lines.push(`    - "host.docker.internal:host-gateway"`);
  }
  lines.push(`  environment:`);
  for (const [k, v] of shape.env) lines.push(`    ${k}: ${JSON.stringify(v)}`);
  // CORS allowlist for a backend that a separate-origin frontend may call:
  // pin it to the frontend origins the topology declares (the generator knows
  // their host ports), so the backend restricts cross-origin access to exactly
  // those instead of a wildcard.  Frontend-only deployables serve no API, so
  // they get no allowlist; a system with no frontend leaves it unset (the
  // backend then applies its own auth-aware fallback).
  if (!platform.isFrontend) {
    const origins = frontendOrigins(sys);
    if (origins.length > 0) {
      lines.push(`    CORS_ORIGIN: ${JSON.stringify(origins.join(","))}`);
    }
  }
  // Same-origin proxy target for a vite-served frontend.  Its bundle fetches
  // `/api` relative, and `vite preview` proxies that to the backend — but
  // inside the compose network the backend is its SERVICE name (not the
  // host's `localhost`), so point the preview proxy at `http://<svc>:<port>`.
  // (Local `vite dev` falls back to the baked localhost target in vite.config.)
  if (shape.injectsApiProxyTarget && d.targetName) {
    const target = sys.deployables.find((t) => t.name === d.targetName);
    if (target) {
      const targetSlug = serviceSlug(target.name);
      const targetPort = platformFor(target.platform).composeService({
        deployable: target,
        sys,
        slug: targetSlug,
      }).internalPort;
      lines.push(
        `    VITE_API_PROXY_TARGET: ${JSON.stringify(`http://${targetSlug}:${targetPort}`)}`,
      );
    }
  }
  if (oidc) {
    const kc = keycloakConfig(sys);
    lines.push(`    OIDC_ISSUER: ${JSON.stringify(kc.issuer)}`);
    lines.push(`    OIDC_CLIENT_ID: ${JSON.stringify(kc.clientId)}`);
    lines.push(
      `    OIDC_REDIRECT_URI: ${JSON.stringify(`http://localhost:${d.port}${AUTH_BASE_PATH}/callback`)}`,
    );
  }
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
