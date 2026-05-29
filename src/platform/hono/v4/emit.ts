// This orchestrator (project assembly: which files, framework wiring,
// package.json/Dockerfile) is backend-specific, so it lives in the
// hono@v4 *package* and drives the shared neutral emitter library
// under `src/generator/typescript/` by ordinary import (package →
// shared).  Over time the remaining Hono-framework builders
// (routes/workflow/view/auth/observability) move in here too, leaving
// only the framework-neutral helpers (render-expr/stmt, templates,
// zod-refine) in core.

// Hono-framework builders now live in this package (P2b) — siblings.
import type { EmitCtx } from "../../../generator/_adapters/index.js";
import { emitTypescriptMigrations } from "../../../generator/typescript/emit/migrations.js";
import {
  renderAggregate,
  renderEnumsAndValueObjects,
  renderEvents,
  renderHttpIndex,
  renderIds,
  renderSchema,
  renderTestsFile,
} from "../../../generator/typescript/emit.js";
import { buildExternHandlersFile } from "../../../generator/typescript/extern-builder.js";
import { buildRepositoryFile } from "../../../generator/typescript/repository-builder.js";
import { enrichLoomModel } from "../../../ir/enrich/enrichments.js";
import { lowerModel } from "../../../ir/lower/lower.js";
import {
  type BoundedContextIR,
  contextUsesMoney,
  type DataSourceIR,
  type DeployableIR,
  type EnrichedBoundedContextIR,
  type FieldIR,
  type RepositoryIR,
  type SystemIR,
  type TypeIR,
  type UserIR,
} from "../../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../../ir/types/migrations-ir.js";
import { contextsHaveProvenancedField } from "../../../ir/util/prov-id.js";
import { resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import type { Model } from "../../../language/generated/ast.js";
import { lowerFirst } from "../../../util/naming.js";
import { byLayerLayoutAdapter } from "./adapters/by-layer-layout.js";
import { layeredStyleAdapter } from "./adapters/layered-style.js";
import { resourceAdapterFor } from "./adapters/resource-clients.js";
import { emitAuthFiles } from "./auth-emit.js";
import { emitObservabilityFiles } from "./observability-builder.js";
import { buildRoutesFile } from "./routes-builder.js";
import { buildViewsRoutesFile } from "./view-routes-builder.js";
import { buildWorkflowsFile } from "./workflow-builder.js";

const ERRORS_TS = `// Auto-generated.
export class DomainError extends Error {
  constructor(message: string) { super(message); this.name = "DomainError"; }
}
export class AggregateNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "AggregateNotFoundError"; }
}
/** Authorization failure — raised by \`requires\` expressions in
 *  operation / workflow bodies when the resolved currentUser
 *  doesn't satisfy the gate.  The per-route catch maps this to
 *  HTTP 403 (Forbidden). */
export class ForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = "ForbiddenError"; }
}
/** Wraps an exception thrown by a user-supplied extern handler.  The
 *  per-router \`app.onError\` maps this to a 500 envelope that names
 *  the offending op + aggregate, instead of the bare
 *  \`{ "error": "internal" }\` operators see when the same throw
 *  bubbles unwrapped.  Domain-layer errors raised by the user
 *  handler (DomainError, ForbiddenError, AggregateNotFoundError)
 *  are NOT wrapped — they bubble through and the router maps them
 *  to their usual status codes. */
export class ExternHandlerError extends Error {
  readonly opName: string;
  readonly aggName: string;
  readonly cause: unknown;
  constructor(opName: string, aggName: string, cause: unknown) {
    const inner = cause instanceof Error ? cause.message : String(cause);
    super(\`Extern handler '\${opName}' on '\${aggName}' threw: \${inner}\`);
    this.name = "ExternHandlerError";
    this.opName = opName;
    this.aggName = aggName;
    this.cause = cause;
  }
}
`;

/** Provenance lineage types — emitted only when the model declares at
 *  least one `provenanced` field that is actually written.  Each
 *  provenanced write builds a `ProvLineage` referencing the compile-time
 *  rule snapshot in `.loom/loomsnap.json`; it is stored co-located on the
 *  aggregate row (the `<field>_provenance` jsonb column) and appended to
 *  the `provenance_records` history table inside the operation's save
 *  transaction (see routes-builder). */
const PROVENANCE_TS = `// Auto-generated.
export interface ProvInput { path: string; value: unknown; }

export interface ProvLineage {
  /** Points at the per-write-site rule snapshot in \`.loom/loomsnap.json\`. */
  snapshotId: string;
  target: { type: string; field: string };
  inputs: ProvInput[];
  computedValue: unknown;
}
`;

/**
 * Legacy entry: lowers the whole model and emits one project from all
 * top-level bounded contexts.  Used by `ddd generate ts <file> -o <dir>`.
 */
export function generateTypeScript(
  model: Model,
  pins: BackendPins,
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  // Lowering produces a faithful AST projection; enrichment populates
  // wireShape, the implicit `findAll` find, and react `moduleNames`
  // inheritance.  Every backend consumes the enriched IR, never the
  // raw lowered output.
  const loom = enrichLoomModel(lowerModel(model));
  return generateTypeScriptForContexts(loom.contexts, pins, undefined, options);
}

/**
 * System-mode entry: emits one project from a pre-filtered list of
 * contexts.  Used by the deployable orchestrator to scope the output
 * to a single deployable's modules.
 *
 * `system` (when present) carries the system-wide user-claim shape +
 * the deployable's auth setting.  When the deployable opts in via
 * `auth: required` AND the system declares a user block, the
 * generator emits the auth/* package + mounts the middleware in
 * http/index.ts.  Loose top-level contexts (no enclosing system)
 * skip the auth path entirely.
 */
export function generateTypeScriptForContexts(
  contexts: EnrichedBoundedContextIR[],
  pins: BackendPins,
  system?: { deployable: DeployableIR; sys: SystemIR; migrations?: MigrationsIR[] },
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  const emitTrace = !!options.emitTrace;
  const out = new Map<string, string>();
  const authRequired = !!(system?.deployable.auth?.required && system.sys.user);
  // Emission is forced by presence: any written `provenanced` field turns
  // on the lineage types + co-located `<field>_provenance` columns + the
  // `provenance_records` history table.  Threaded as a flag (rather than
  // read off presence at each call site) so a future build-level switch
  // can force emission for other consumers.
  const emitProvenance = contextsHaveProvenancedField(contexts);
  // Emission is forced by presence: any `audited` operation turns on the
  // audit SDK + per-route `recordAudit` calls.  Threaded as a flag (like
  // emitProvenance) so a future build-level switch can force emission.
  const emitAudit = contexts.some((c) =>
    c.aggregates.some((a) => a.operations.some((o) => o.audited)),
  );

  // Multi-context Hono deployables (e.g. acme's catalogWeb spanning
  // Catalog + CustomerMgmt) need the shared domain files to UNION
  // every context's content rather than overwrite per-context.  The
  // .NET path already merges this way via a synthetic `merged`
  // context; we mirror that here so `domain/ids.ts`,
  // `domain/value-objects.ts`, `domain/events.ts`, `db/schema.ts`,
  // `http/workflows.ts`, `http/views.ts`, and `http/index.ts` all
  // reflect the FULL aggregate / VO / enum / event set.
  const merged: EnrichedBoundedContextIR = {
    name: contexts[0]?.name ?? "merged",
    enums: contexts.flatMap((c) => c.enums),
    valueObjects: contexts.flatMap((c) => c.valueObjects),
    events: contexts.flatMap((c) => c.events),
    aggregates: contexts.flatMap((c) => c.aggregates),
    repositories: contexts.flatMap((c) => c.repositories),
    workflows: contexts.flatMap((c) => c.workflows),
    views: contexts.flatMap((c) => c.views),
  };

  out.set("domain/ids.ts", renderIds(merged));
  out.set("domain/value-objects.ts", renderEnumsAndValueObjects(merged));
  out.set("domain/events.ts", renderEvents(merged));
  out.set("domain/errors.ts", ERRORS_TS);
  if (emitProvenance) out.set("domain/provenance.ts", PROVENANCE_TS);
  // Per-aggregate dataSource lookup — feeds `pgSchema(...)` /
  // `<schema>.table(...)` / `tablePrefix` routing in `renderSchema`.
  // Returns `undefined` for systems without a matching binding, which
  // falls back to the existing plain `pgTable(...)` shape.
  const resolveDataSource = system
    ? (agg: import("../../../ir/types/loom-ir.js").AggregateIR) => {
        const owningCtx = contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
        return owningCtx
          ? resolveDataSourceConfig(
              agg as import("../../../ir/types/loom-ir.js").EnrichedAggregateIR,
              owningCtx,
              system.sys,
            )
          : undefined;
      }
    : undefined;
  out.set(
    "db/schema.ts",
    renderSchema(merged, { audit: emitAudit, provenance: emitProvenance, resolveDataSource }),
  );
  if (merged.workflows.length > 0) {
    const aggsByName = new Map(merged.aggregates.map((a) => [a.name, a] as const));
    out.set("http/workflows.ts", buildWorkflowsFile(merged, aggsByName));
  }
  if (merged.views.length > 0) {
    const aggsByName = new Map(merged.aggregates.map((a) => [a.name, a] as const));
    out.set("http/views.ts", buildViewsRoutesFile(merged, aggsByName));
  }
  out.set("http/index.ts", renderHttpIndex(merged, { authRequired }));

  // Adapter dispatch context — present only in system-mode emit so
  // routes-file emission can route through the layered StyleAdapter +
  // byLayer LayoutAdapter.  Other per-aggregate emissions (aggregate
  // module, repository, extern handler, tests) still write inline
  // paths; future slices can move them under the persistence adapter +
  // additional layout categories.
  const emitCtx: EmitCtx | undefined = system
    ? {
        deployable: system.deployable,
        contexts,
        sys: system.sys,
        migrations: system.migrations,
        emitTrace,
      }
    : undefined;
  // Per-aggregate emission stays per-context — each aggregate file
  // and its repository / routes are emitted in the context that
  // owns the aggregate.
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      const repo = findRepoFor(ctx, agg.name);
      out.set(
        `domain/${lowerFirst(agg.name)}.ts`,
        renderAggregate(agg, ctx, emitProvenance, emitTrace),
      );
      out.set(
        `db/repositories/${lowerFirst(agg.name)}-repository.ts`,
        buildRepositoryFile(agg, repo, ctx, emitTrace),
      );
      // Routes file — adapter-dispatched in system mode (the layered
      // StyleAdapter re-derives audit / provenance gates from
      // ctx.contexts so the output matches `buildRoutesFile(...,
      // emitAudit, emitProvenance, emitTrace)` byte-for-byte); direct
      // call in legacy single-context mode.
      if (emitCtx) {
        const artifacts = layeredStyleAdapter.emitForAggregate?.(agg, emitCtx) ?? [];
        for (const artifact of artifacts) {
          out.set(byLayerLayoutAdapter.pathFor(artifact, emitCtx), artifact.content);
        }
      } else {
        out.set(
          `http/${lowerFirst(agg.name)}.routes.ts`,
          buildRoutesFile(agg, repo, ctx, emitAudit, emitProvenance, emitTrace),
        );
      }
      if (agg.operations.some((o) => o.extern)) {
        out.set(`domain/${lowerFirst(agg.name)}-extern.ts`, buildExternHandlersFile(agg, ctx));
      }
      const testsFile = renderTestsFile(agg, ctx);
      if (testsFile) {
        out.set(`domain/${lowerFirst(agg.name)}.test.ts`, testsFile);
      }
    }
  }

  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, out);
  }
  emitObservabilityFiles(out);
  // Per-module Postgres migrations + Drizzle journal — emitted whenever
  // the system orchestrator hands us a migrations slice.  Empty slice
  // (non-system entry points) → no-op.
  const hasMigrations = !!(system?.migrations && system.migrations.length > 0);
  if (hasMigrations) {
    emitTypescriptMigrations(system!.migrations!, out);
  }
  // decimal.js is conditional: only depended on when at least one
  // aggregate in any of the served contexts uses a `money` field.
  // Server bundle size matters; client-side React always ships the
  // dep.  Detected by walking the IR rather than scanning the rendered
  // strings.
  // Resource clients (objectStore / queue / api) — boot-time client
  // modules for the new infrastructure kinds the deployable wires
  // (RFC §Phase 2.4 foundation).  Additive + gated: a deployable with
  // no such resources emits nothing, so existing models stay
  // byte-identical.  No call-sites — those land with the workflow-level
  // consumption surface (Phase 4).
  const resourceDeps: Record<string, string> = {};
  const resourceImports: string[] = [];
  if (system) {
    const wired = new Set(system.deployable.dataSourceNames);
    const storeType = new Map(system.sys.storages.map((s) => [s.name, s.type] as const));
    const bySourceType = new Map<string, DataSourceIR[]>();
    for (const r of system.sys.dataSources) {
      if (!wired.has(r.name)) continue;
      if (r.kind !== "objectStore" && r.kind !== "queue" && r.kind !== "api") continue;
      const st = storeType.get(r.storageName);
      if (!st) continue;
      const group = bySourceType.get(st);
      if (group) group.push(r);
      else bySourceType.set(st, [r]);
    }
    const resourceCtx: EmitCtx = {
      deployable: system.deployable,
      contexts,
      sys: system.sys,
    };
    for (const [sourceType, group] of bySourceType) {
      const adapter = resourceAdapterFor(sourceType);
      if (!adapter) continue;
      out.set(
        `resources/${sourceType}.ts`,
        `${adapter.emitClientModule(group, system.sys.storages, resourceCtx).join("\n")}\n`,
      );
      Object.assign(resourceDeps, adapter.emitProjectDeps(resourceCtx));
      resourceImports.push(`import "./resources/${sourceType}";`);
    }
  }

  const projectUsesMoney = contexts.some(contextUsesMoney);
  out.set("package.json", projectPackageJson(pins, { withMoney: projectUsesMoney, resourceDeps }));
  // Shared primitive-schema helpers — one home for non-trivial wire
  // shapes (today: `moneySchema`).  Emitted only when something in
  // the project uses money so non-money projects' tsc surface stays
  // identical.
  if (projectUsesMoney) {
    out.set("lib/schemas.ts", LIB_SCHEMAS_MONEY_TS);
  }
  out.set("tsconfig.json", PROJECT_TSCONFIG_JSON);
  out.set("tsup.config.ts", TSUP_CONFIG);
  out.set(
    "index.ts",
    renderProjectIndexTs(
      hasMigrations,
      authRequired ? system?.sys.user : undefined,
      resourceImports,
    ),
  );
  out.set("drizzle.config.ts", DRIZZLE_CONFIG);
  out.set("Dockerfile", DOCKERFILE_TS);
  out.set(".dockerignore", DOCKERIGNORE_TS);
  out.set("certs/.gitkeep", "");
  return out;
}

function findRepoFor(ctx: BoundedContextIR, name: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === name);
}

// The shared TypeScript/Hono emitter is version-agnostic.  Dep pins
// are owned by the active backend
// *package* (`src/platform/hono/<vN>/pins.ts`) and threaded in as a
// parameter; the emitter never imports a package (no shared→package
// edge), so it stays usable by any backend version and a future
// `hono@v5` just passes different pins.
export interface BackendPins {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function projectPackageJson(
  pins: BackendPins,
  opts: { withMoney: boolean; resourceDeps?: Record<string, string> },
): string {
  return (
    JSON.stringify(
      {
        name: "ddd-generated-app",
        version: "0.0.0",
        type: "module",
        private: true,
        scripts: {
          dev: "tsx index.ts",
          build: "tsup",
          typecheck: "tsc --noEmit",
          test: "vitest run",
          // We emit Drizzle-format `meta/_journal.json` + .sql files so
          // both `drizzle-kit migrate` (the CLI) and
          // `drizzle-orm/.../migrator` (called from index.ts at boot)
          // can apply them.  `drizzle-kit generate` is left available
          // for users who want to introspect the schema, but Loom owns
          // the SQL generation end-to-end.
          "db:generate": "drizzle-kit generate",
          "db:migrate": "drizzle-kit migrate",
          "db:push": "drizzle-kit push",
          "db:studio": "drizzle-kit studio",
        },
        dependencies: {
          ...pins.dependencies,
          ...(opts.withMoney ? { "decimal.js": "^10.4.3" } : {}),
          ...(opts.resourceDeps ?? {}),
        },
        devDependencies: { ...pins.devDependencies },
      },
      null,
      2,
    ) + "\n"
  );
}

const DRIZZLE_CONFIG = `// Auto-generated.  Drizzle Kit configuration — adjust to taste.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
  },
});
`;

// Shared primitive-schema helpers — emitted to `lib/schemas.ts` when
// the project uses money.  Single canonical wire-shape for the
// money primitive: parses a decimal-formatted string, surfaces parse
// failures as typed Zod issues (so bad input becomes a typed 400, not
// an uncaught throw → 500), and exposes the parsed `Decimal`
// instance to route handlers.  Routes reference `moneySchema` rather
// than redeclaring the chain at every field site.
const LIB_SCHEMAS_MONEY_TS = `// Auto-generated.  Do not edit by hand.
import Decimal from "decimal.js";
import { z } from "@hono/zod-openapi";

/**
 * Wire schema for the \`money\` primitive.
 *
 * Inbound JSON: a decimal-formatted string (\`"123.4500"\`).  Parses
 * to a \`decimal.js\` Decimal instance.  Format violations and parse
 * failures both surface as typed Zod issues — invalid input becomes
 * a 400 with the field name attached, not an uncaught throw.
 */
export const moneySchema = z.string().transform((s, ctx) => {
  if (!/^-?\\d+(\\.\\d+)?$/.test(s)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
  try {
    return new Decimal(s);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
});
`;

const PROJECT_TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        // ES2022 is the highest target drizzle-kit's bundled
        // @esbuild-kit/esm-loader accepts; tsup's own `target: "node24"`
        // (in tsup.config.ts) is what governs the prod bundle.
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        // tsup handles emit (single bundled `dist/index.js`); tsc is
        // type-check only via `npm run typecheck`.
        noEmit: true,
        // `Bundler` resolution lets relative imports omit the `.js`
        // extension — esbuild (via tsup at build time, tsx at dev
        // time, vite-node at test time) resolves them.
      },
      include: ["**/*.ts"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2,
  ) + "\n";

const TSUP_CONFIG = `// Auto-generated.  tsup bundles index.ts → dist/index.js for
// production.  Externals match runtime deps from package.json so
// pg's native bindings + drizzle's heavy modules stay outside the
// bundle (loaded from node_modules at runtime).
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  // \`tsc --noEmit\` (npm run typecheck) is the type-check; tsup is
  // build-only, no .d.ts emit needed.
  dts: false,
});
`;

function renderProjectIndexTs(
  runMigrationsAtBoot: boolean,
  userShape?: UserIR,
  resourceImports: readonly string[] = [],
): string {
  // Side-effect imports for the resource-client modules (objectStore /
  // queue / api) so their clients instantiate at boot.  Empty for
  // deployables with no such resources — byte-identical to before.
  const resourceImportBlock = resourceImports.length > 0 ? `${resourceImports.join("\n")}\n` : "";
  const migImport = runMigrationsAtBoot
    ? `import { migrate } from "drizzle-orm/node-postgres/migrator";\n`
    : "";
  const migCall = runMigrationsAtBoot
    ? `\n// Apply pending schema migrations before serving traffic.  Drizzle's\n// runtime migrator reads db/migrations/meta/_journal.json + each\n// referenced .sql file, tracking state in \`__drizzle_migrations\`;\n// idempotent across boots.\nawait migrate(db, { migrationsFolder: "./db/migrations" });\n`
    : "";
  // createApp() calls assertUserVerifierRegistered() when auth is required —
  // emit a permissive dev stub so the generated stack boots out of the box.
  // Replace this in production with a real JWT-decoding verifier (e.g. in
  // a separate file kept out of the regen list and imported here).
  const authStubImport = userShape
    ? `import { registerUserVerifier } from "./auth/verifier";\n`
    : "";
  const authStubCall = userShape
    ? `\n// Dev-stub verifier — accepts every request as a built-in admin user.\n// REPLACE for production by calling registerUserVerifier(...) with a JWT-\n// decoding implementation, ideally from a separate (non-regenerated) file.\nregisterUserVerifier(() => (${renderStubUserLiteral(userShape)}));\nbaseLogger.warn({ event: "auth_dev_stub_registered" });\n`
    : "";
  return `// Auto-generated.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { serve } from "@hono/node-server";
import * as schema from "./db/schema";
import { createApp } from "./http/index";
${migImport}${authStubImport}import { baseLogger } from "./obs/log";
${resourceImportBlock}
// Fail fast on a missing DATABASE_URL.  Without this an unset value
// surfaces as a confusing pg connection refusal mid-request; we'd
// rather die at boot with a clear pointer to the env var.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required.  Set it in the environment " +
      "(e.g. postgres://user:pass@host:5432/db).",
  );
}

const port = Number(process.env.PORT ?? 3000);
baseLogger.info({ event: "server_starting", port, env: process.env.NODE_ENV ?? "development" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// Surface pool-level connection errors on the structured stream — a
// dropped backend connection (DB restart, network blip) emits 'error'
// on the pool, not per-query.  Without this hook the failure surfaces
// only as the NEXT request's 503 from /ready or a 500 from an
// aggregate route; logging here gives ops the heads-up + the cause.
pool.on("error", (err) => {
  baseLogger.warn({
    event: "db_disconnected",
    reason: err instanceof Error ? err.message : String(err),
  });
});
const db = drizzle(pool, { schema });
${migCall}${authStubCall}const app = createApp(db);
const server = serve({ fetch: app.fetch, port });
baseLogger.info({ event: "server_listening", port });

// Graceful shutdown — close the HTTP server (stops accepting,
// drains in-flight), then close the pg pool.  Without this SIGTERM
// drops in-flight work and leaves pg connections lingering.  Both
// SIGTERM (orchestrator) and SIGINT (Ctrl-C) are handled.
async function shutdown(signal: string): Promise<void> {
  baseLogger.info({ event: "server_shutdown", signal });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  baseLogger.info({ event: "server_drained" });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
`;
}

/** Build a TS object literal matching the system's `user {}` shape, with
 *  sensible defaults per primitive type — used as the body of the dev-stub
 *  user verifier so a generated app boots without the caller having to wire
 *  a JWT decoder. */
function renderStubUserLiteral(userShape: UserIR): string {
  const entries = userShape.fields.map((f) => `  ${snakeToCamel(f.name)}: ${stubValueFor(f)}`);
  return `{\n${entries.join(",\n")},\n}`;
}

function stubValueFor(f: FieldIR): string {
  if (f.optional) return "null";
  return stubValueForType(f.type);
}

function stubValueForType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return `"admin"`;
        case "int":
        case "long":
          return "0";
        case "decimal":
        case "money":
          return `"0"`;
        case "bool":
          return "false";
        case "datetime":
          return `new Date(0)`;
        case "guid":
          return `"00000000-0000-0000-0000-000000000000"`;
        default:
          return `""`;
      }
    case "id":
      return `"00000000-0000-0000-0000-000000000000"`;
    case "array":
      return "[]";
    default:
      return "null";
  }
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Multi-stage Dockerfile: build stage installs all deps and compiles
// TypeScript; runtime stage uses a smaller production-only image.
const DOCKERFILE_TS = `# syntax=docker/dockerfile:1
# Auto-generated.

FROM node:24-alpine AS build
WORKDIR /app
# Optional proxy CAs — drop *.crt files into ./certs/ to make npm
# trust them.  The directory always exists (with a .gitkeep), so
# this COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN cat /usr/local/share/ca-certificates/*.crt 2>/dev/null >> /etc/ssl/cert.pem || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem NPM_CONFIG_CAFILE=/etc/ssl/cert.pem
COPY package.json ./
# Use plain "npm install" rather than "npm ci": the generator emits no
# package-lock.json so npm ci exits with EUSAGE.  --no-audit --no-fund
# keeps the build log clean and skips two registry round-trips.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Drizzle's runtime migrator reads migration SQL + meta/_journal.json
# from disk; without these the process crashes on boot with
# "Can't find meta/_journal.json file".
COPY --from=build /app/db/migrations ./db/migrations
EXPOSE 3000
CMD ["node", "dist/index.js"]
`;

const DOCKERIGNORE_TS = `# Auto-generated.
node_modules
out
.git
.env
.env.*
*.log
`;
