import type {
  AggregateIR,
  BoundedContextIR,
  RepositoryIR,
} from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const ROUTES_TPL = hb.compile(
  `// Auto-generated.
import { Hono } from "hono";
import { z } from "zod";
import { {{aggregate.name}} } from "../domain/{{camel aggregate.name}}.js";
import { {{aggregate.name}}Repository } from "../db/repositories/{{camel aggregate.name}}-repository.js";
import * as Ids from "../domain/ids.js";
import { DomainError, AggregateNotFoundError } from "../domain/errors.js";

export function {{camel aggregate.name}}Routes(repo: {{aggregate.name}}Repository): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const schema = z.object({
{{#each (requiredFields aggregate.fields)}}      {{name}}: {{typeJsonSchema type}},
{{/each}}    });
    const body = schema.parse(await c.req.json());
    const created = {{aggregate.name}}.create(body as never);
    await repo.save(created);
    return c.json({ id: created.id }, 201);
  });

  app.get("/:id", async (c) => {
    const found = await repo.findById(Ids.{{aggregate.name}}Id(c.req.param("id")));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json({ id: found.id });
  });

{{#each publicOperations}}
  app.post("/:id/{{snake name}}", async (c) => {
    const schema = z.object({
{{#each params}}      {{name}}: {{typeJsonSchema type}},
{{/each}}    });
    const body = {{#if params.length}}schema.parse(await c.req.json()){{else}}{}{{/if}};
    const aggregate = await repo.getById(Ids.{{../aggregate.name}}Id(c.req.param("id")));
    aggregate.{{camel name}}({{#each params}}body.{{name}} as never{{#unless @last}}, {{/unless}}{{/each}});
    await repo.save(aggregate);
    return c.json({ ok: true });
  });

{{/each}}
{{#each finds}}
  app.get("/{{snake name}}", async (c) => {
    const schema = z.object({
{{#each params}}      {{name}}: {{typeJsonSchema type}},
{{/each}}    });
    const params = schema.parse(c.req.query());
    const result = await repo.{{name}}({{#each params}}params.{{name}} as never{{#unless @last}}, {{/unless}}{{/each}});
    return c.json(result);
  });

{{/each}}
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, 400);
    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message }, 404);
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
`,
);

const HTTP_INDEX_TPL = hb.compile(
  `// Auto-generated.
import { Hono } from "hono";
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
): Hono {
  const app = new Hono();
{{#each aggregates}}  app.route("/{{snake (plural name)}}", {{camel name}}Routes(new {{name}}Repository(db, events)));
{{/each}}  return app;
}
`,
);

export function renderRoutes(agg: AggregateIR, repo: RepositoryIR | undefined): string {
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  return ROUTES_TPL({
    aggregate: agg,
    publicOperations: publicOps,
    finds: repo?.finds ?? [],
  });
}

export function renderHttpIndex(ctx: BoundedContextIR): string {
  return HTTP_INDEX_TPL({ aggregates: ctx.aggregates });
}
