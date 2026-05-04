import type { Model } from "../../language/generated/ast.js";
import { lowerModel } from "../../ir/lower.js";
import type { BoundedContextIR, RepositoryIR } from "../../ir/loom-ir.js";
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
import { buildRepositoryFile } from "./repository-builder.js";
import { buildRoutesFile } from "./routes-builder.js";

const ERRORS_TS = `// Auto-generated.
export class DomainError extends Error {
  constructor(message: string) { super(message); this.name = "DomainError"; }
}
export class AggregateNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "AggregateNotFoundError"; }
}
`;

/**
 * Legacy entry: lowers the whole model and emits one project from all
 * top-level bounded contexts.  Used by `ddd generate ts <file> -o <dir>`.
 */
export function generateTypeScript(model: Model): Map<string, string> {
  const loom = lowerModel(model);
  return generateTypeScriptForContexts(loom.contexts);
}

/**
 * System-mode entry: emits one project from a pre-filtered list of
 * contexts.  Used by the deployable orchestrator to scope the output
 * to a single deployable's modules.
 */
export function generateTypeScriptForContexts(
  contexts: BoundedContextIR[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const ctx of contexts) {
    emitContext(ctx, out);
  }
  out.set("package.json", PROJECT_PACKAGE_JSON);
  out.set("tsconfig.json", PROJECT_TSCONFIG_JSON);
  out.set("index.ts", PROJECT_INDEX_TS);
  out.set("drizzle.config.ts", DRIZZLE_CONFIG);
  out.set("Dockerfile", DOCKERFILE_TS);
  out.set(".dockerignore", DOCKERIGNORE_TS);
  out.set("certs/.gitkeep", "");
  return out;
}

function emitContext(ctx: BoundedContextIR, out: Map<string, string>): void {
  out.set("domain/ids.ts", renderIds(ctx));
  out.set("domain/value-objects.ts", renderEnumsAndValueObjects(ctx));
  out.set("domain/events.ts", renderEvents(ctx));
  out.set("domain/errors.ts", ERRORS_TS);
  for (const agg of ctx.aggregates) {
    const repo = findRepoFor(ctx, agg.name);
    out.set(`domain/${camel(agg.name)}.ts`, renderAggregate(agg, ctx));
    out.set(
      `db/repositories/${camel(agg.name)}-repository.ts`,
      buildRepositoryFile(agg, repo, ctx),
    );
    out.set(`http/${camel(agg.name)}.routes.ts`, buildRoutesFile(agg, repo, ctx));
    const testsFile = renderTestsFile(agg, ctx);
    if (testsFile) {
      out.set(`domain/${camel(agg.name)}.test.ts`, testsFile);
    }
  }
  out.set("db/schema.ts", renderSchema(ctx));
  out.set("http/index.ts", renderHttpIndex(ctx));
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
      build: "tsc",
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
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: "out",
      rootDir: ".",
    },
    include: ["**/*.ts"],
    exclude: ["node_modules", "out"],
  },
  null,
  2,
) + "\n";

const PROJECT_INDEX_TS = `// Auto-generated.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { serve } from "@hono/node-server";
import * as schema from "./db/schema.js";
import { createApp } from "./http/index.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
const app = createApp(db);
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
console.log("listening on", process.env.PORT ?? 3000);
`;

// Multi-stage Dockerfile: build stage installs all deps and compiles
// TypeScript; runtime stage uses a smaller production-only image.
const DOCKERFILE_TS = `# syntax=docker/dockerfile:1
# Auto-generated.

FROM node:22-alpine AS build
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

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "out/index.js"]
`;

const DOCKERIGNORE_TS = `# Auto-generated.
node_modules
out
.git
.env
.env.*
*.log
`;
