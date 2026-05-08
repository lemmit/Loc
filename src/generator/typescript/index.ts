import type { Model } from "../../language/generated/ast.js";
import { lowerModel } from "../../ir/lower.js";
import { enrichLoomModel } from "../../ir/enrichments.js";
import type {
  BoundedContextIR,
  DeployableIR,
  RepositoryIR,
  SystemIR,
} from "../../ir/loom-ir.js";
import { camel } from "../../util/naming.js";
import {
  renderAggregate,
  renderEnumsAndValueObjects,
  renderEvents,
  renderHttpIndex,
  renderIds,
  renderSchema,
  renderTestsFile,
} from "./templates.js";
import { emitAuthFiles } from "./auth-emit.js";
import { buildRepositoryFile } from "./repository-builder.js";
import { buildRoutesFile } from "./routes-builder.js";
import { buildExternHandlersFile } from "./extern-builder.js";
import { buildWorkflowsFile } from "./workflow-builder.js";
import { buildViewsRoutesFile } from "./view-routes-builder.js";
import { emitObservabilityFiles } from "./observability-builder.js";

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

/**
 * Legacy entry: lowers the whole model and emits one project from all
 * top-level bounded contexts.  Used by `ddd generate ts <file> -o <dir>`.
 */
export function generateTypeScript(model: Model): Map<string, string> {
  // Lowering produces a faithful AST projection; enrichment populates
  // wireShape, the implicit `findAll` find, and react `moduleNames`
  // inheritance.  Every backend consumes the enriched IR, never the
  // raw lowered output.
  const loom = enrichLoomModel(lowerModel(model));
  return generateTypeScriptForContexts(loom.contexts);
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
  contexts: BoundedContextIR[],
  system?: { deployable: DeployableIR; sys: SystemIR },
): Map<string, string> {
  const out = new Map<string, string>();
  const authRequired = !!(
    system?.deployable.auth?.required && system.sys.user
  );

  // Multi-context Hono deployables (e.g. acme's catalogWeb spanning
  // Catalog + CustomerMgmt) need the shared domain files to UNION
  // every context's content rather than overwrite per-context.  The
  // .NET path already merges this way via a synthetic `merged`
  // context; we mirror that here so `domain/ids.ts`,
  // `domain/value-objects.ts`, `domain/events.ts`, `db/schema.ts`,
  // `http/workflows.ts`, `http/views.ts`, and `http/index.ts` all
  // reflect the FULL aggregate / VO / enum / event set.
  const merged: BoundedContextIR = {
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
  out.set("db/schema.ts", renderSchema(merged));
  if (merged.workflows.length > 0) {
    const aggsByName = new Map(
      merged.aggregates.map((a) => [a.name, a] as const),
    );
    out.set("http/workflows.ts", buildWorkflowsFile(merged, aggsByName));
  }
  if (merged.views.length > 0) {
    const aggsByName = new Map(
      merged.aggregates.map((a) => [a.name, a] as const),
    );
    out.set("http/views.ts", buildViewsRoutesFile(merged, aggsByName));
  }
  out.set(
    "http/index.ts",
    renderHttpIndex(merged, { authRequired }),
  );

  // Per-aggregate emission stays per-context — each aggregate file
  // and its repository / routes are emitted in the context that
  // owns the aggregate.
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      const repo = findRepoFor(ctx, agg.name);
      out.set(`domain/${camel(agg.name)}.ts`, renderAggregate(agg, ctx));
      out.set(
        `db/repositories/${camel(agg.name)}-repository.ts`,
        buildRepositoryFile(agg, repo, ctx),
      );
      out.set(
        `http/${camel(agg.name)}.routes.ts`,
        buildRoutesFile(agg, repo, ctx),
      );
      if (agg.operations.some((o) => o.extern)) {
        out.set(
          `domain/${camel(agg.name)}-extern.ts`,
          buildExternHandlersFile(agg, ctx),
        );
      }
      const testsFile = renderTestsFile(agg, ctx);
      if (testsFile) {
        out.set(`domain/${camel(agg.name)}.test.ts`, testsFile);
      }
    }
  }

  if (authRequired && system?.sys) {
    emitAuthFiles(system.sys, out);
  }
  emitObservabilityFiles(out);
  out.set("package.json", PROJECT_PACKAGE_JSON);
  out.set("tsconfig.json", PROJECT_TSCONFIG_JSON);
  out.set("tsup.config.ts", TSUP_CONFIG);
  out.set("index.ts", PROJECT_INDEX_TS);
  out.set("drizzle.config.ts", DRIZZLE_CONFIG);
  out.set("Dockerfile", DOCKERFILE_TS);
  out.set(".dockerignore", DOCKERIGNORE_TS);
  out.set("certs/.gitkeep", "");
  return out;
}

function findRepoFor(ctx: BoundedContextIR, name: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === name);
}

const PROJECT_PACKAGE_JSON = JSON.stringify(
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
      "db:generate": "drizzle-kit generate",
      "db:migrate": "drizzle-kit migrate",
      "db:push": "drizzle-kit push",
      "db:studio": "drizzle-kit studio",
    },
    dependencies: {
      hono: "^4.6.0",
      "@hono/node-server": "^1.13.0",
      "@hono/zod-openapi": "^0.18.0",
      zod: "^3.23.0",
      "drizzle-orm": "^0.36.0",
      pg: "^8.13.0",
    },
    devDependencies: {
      typescript: "^5.7.0",
      tsx: "^4.19.0",
      tsup: "^8.3.0",
      vitest: "^2.1.0",
      "drizzle-kit": "^0.28.0",
      "@types/pg": "^8.11.0",
    },
  },
  null,
  2,
) + "\n";

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

const PROJECT_TSCONFIG_JSON = JSON.stringify(
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

const PROJECT_INDEX_TS = `// Auto-generated.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { serve } from "@hono/node-server";
import * as schema from "./db/schema";
import { createApp } from "./http/index";

// Fail fast on a missing DATABASE_URL.  Without this an unset value
// surfaces as a confusing pg connection refusal mid-request; we'd
// rather die at boot with a clear pointer to the env var.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required.  Set it in the environment " +
      "(e.g. postgres://user:pass@host:5432/db).",
  );
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
const app = createApp(db);
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
console.log("listening on", process.env.PORT ?? 3000);

// Graceful shutdown — close the HTTP server (stops accepting,
// drains in-flight), then close the pg pool.  Without this SIGTERM
// drops in-flight work and leaves pg connections lingering.  Both
// SIGTERM (orchestrator) and SIGINT (Ctrl-C) are handled.
async function shutdown(signal: string): Promise<void> {
  console.log(\`shutting down (\${signal}) — draining in-flight requests\`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
`;

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
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
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
