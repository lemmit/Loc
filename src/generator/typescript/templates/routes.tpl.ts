import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

// The per-aggregate routes file is built procedurally in
// `routes-builder.ts` because the OpenAPI annotations push it past
// what's pleasant to read in a template.  This file owns just the
// `createApp` composition entry, which mounts each aggregate's
// sub-router and exposes `/openapi.json`.
const HTTP_INDEX_TPL = hb.compile(
  `// Auto-generated.
import { OpenAPIHono } from "@hono/zod-openapi";
{{#each aggregates}}
import { {{camel name}}Routes } from "./{{camel name}}.routes.js";
import { {{name}}Repository } from "../db/repositories/{{camel name}}-repository.js";
{{/each}}
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { type DomainEventDispatcher, NoopDomainEventDispatcher } from "../domain/events.js";

export function createApp(
  db: NodePgDatabase<typeof schema>,
  events: DomainEventDispatcher = NoopDomainEventDispatcher,
): OpenAPIHono {
  const app = new OpenAPIHono();
  // Liveness probe — used by docker-compose / kubernetes / smoke tests.
  app.get("/health", (c) => c.json({ status: "ok" }));
{{#each aggregates}}  app.route("/{{snake (plural name)}}", {{camel name}}Routes(new {{name}}Repository(db, events)));
{{/each}}
  // OpenAPI 3.1 spec assembled from every sub-router's createRoute()
  // calls.  Diffed against the .NET-emitted /swagger/v1/swagger.json by
  // the cross-platform contract check.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Generated API", version: "1.0.0" },
  });
  return app;
}
`,
);

export function renderHttpIndex(ctx: BoundedContextIR): string {
  return HTTP_INDEX_TPL({ aggregates: ctx.aggregates });
}
