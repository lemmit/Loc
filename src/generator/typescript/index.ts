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
  renderRepository,
  renderRoutes,
  renderSchema,
} from "./templates.js";

const ERRORS_TS = `// Auto-generated.
export class DomainError extends Error {
  constructor(message: string) { super(message); this.name = "DomainError"; }
}
export class AggregateNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "AggregateNotFoundError"; }
}
`;

export function generateTypeScript(model: Model): Map<string, string> {
  const out = new Map<string, string>();
  const loom = lowerModel(model);
  for (const ctx of loom.contexts) {
    emitContext(ctx, out);
  }
  out.set("package.json", PROJECT_PACKAGE_JSON);
  out.set("tsconfig.json", PROJECT_TSCONFIG_JSON);
  out.set("index.ts", PROJECT_INDEX_TS);
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
      renderRepository(agg, repo),
    );
    out.set(`http/${camel(agg.name)}.routes.ts`, renderRoutes(agg, repo));
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
    },
    dependencies: {
      hono: "^4.6.0",
      "@hono/node-server": "^1.13.0",
      zod: "^3.23.0",
      "drizzle-orm": "^0.36.0",
      pg: "^8.13.0",
    },
    devDependencies: {
      typescript: "^5.7.0",
      tsx: "^4.19.0",
      "@types/pg": "^8.11.0",
    },
  },
  null,
  2,
) + "\n";

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
