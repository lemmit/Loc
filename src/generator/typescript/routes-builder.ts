import type {
  AggregateIR,
  BoundedContextIR,
  EnumIR,
  OperationIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono routes file with OpenAPI annotations.
//
// Replaces the legacy hand-rolled `app.post(path, async (c) => …)` style
// with `@hono/zod-openapi`'s `OpenAPIHono` + `createRoute({ method, path,
// request, responses })`.  Side-effect: every route's request body is
// typed by zod and validated automatically; `c.req.valid("json")`
// returns the parsed shape with no `as never` cast needed.
//
// The /openapi.json endpoint is exposed by `createApp` (in
// http/index.ts), composing all aggregate sub-routers under
// `app.doc(...)`.
// ---------------------------------------------------------------------------

export function buildRoutesFile(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { ${agg.name} } from "../domain/${camel(agg.name)}.js";`);
  lines.push(
    `import { ${agg.name}Repository } from "../db/repositories/${camel(agg.name)}-repository.js";`,
  );
  lines.push(`import * as Ids from "../domain/ids.js";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError } from "../domain/errors.js";`,
  );
  lines.push("");

  // Schemas — value objects, enums, then per-operation request /
  // response shapes.  Named via `.openapi("Foo")` so they appear in the
  // spec's `components.schemas` section (referenced rather than inlined).
  const usedVOs = collectUsedValueObjects(agg, repo, ctx);
  const usedEnums = collectUsedEnums(agg, repo, ctx);

  for (const e of usedEnums) {
    const values = e.values.map((v) => `"${v}"`).join(", ");
    lines.push(`const ${e.name}Schema = z.enum([${values}]).openapi("${e.name}");`);
  }
  for (const vo of usedVOs) {
    lines.push(`const ${vo.name}Schema = z.object({`);
    for (const f of vo.fields) {
      lines.push(`  ${f.name}: ${zodFor(f.type)},`);
    }
    lines.push(`}).openapi("${vo.name}");`);
  }
  lines.push("");

  // Per-operation request schemas.
  const requiredFields = agg.fields.filter((f) => !f.optional);
  lines.push(`const Create${agg.name}Request = z.object({`);
  for (const f of requiredFields) {
    lines.push(`  ${f.name}: ${zodFor(f.type)},`);
  }
  lines.push(`}).openapi("Create${agg.name}Request");`);
  lines.push(`const Create${agg.name}Response = z.object({ id: z.string() }).openapi("Create${agg.name}Response");`);
  lines.push("");

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(`const ${cap(op.name)}Request = z.object({`);
    for (const p of op.params) {
      lines.push(`  ${p.name}: ${zodFor(p.type)},`);
    }
    lines.push(`}).openapi("${cap(op.name)}Request");`);
  }
  lines.push("");

  if (repo) {
    for (const find of repo.finds) {
      lines.push(`const ${cap(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodFor(p.type)},`);
      }
      lines.push(`}).openapi("${cap(find.name)}Query");`);
    }
  }

  // Read-side response.  For v1 we expose `{ id }` only — full
  // projection is the next slice; the cross-check will surface this
  // as a known shape difference vs .NET.
  lines.push(
    `const ${agg.name}Response = z.object({ id: z.string() }).openapi("${agg.name}Response");`,
  );
  lines.push(
    `const ${agg.name}ListResponse = z.array(${agg.name}Response).openapi("${agg.name}ListResponse");`,
  );
  lines.push(`const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");`);
  lines.push("");

  // The router.
  lines.push(
    `export function ${camel(agg.name)}Routes(repo: ${agg.name}Repository): OpenAPIHono {`,
  );
  lines.push(`  const app = new OpenAPIHono();`);
  lines.push("");

  // Create.
  lines.push(`  app.openapi(`);
  lines.push(`    createRoute({`);
  lines.push(`      method: "post",`);
  lines.push(`      path: "/",`);
  lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
  lines.push(`      operationId: "create${agg.name}",`);
  lines.push(`      request: {`);
  lines.push(
    `        body: { content: { "application/json": { schema: Create${agg.name}Request } } },`,
  );
  lines.push(`      },`);
  lines.push(`      responses: {`);
  lines.push(`        201: {`);
  lines.push(`          description: "Created",`);
  lines.push(
    `          content: { "application/json": { schema: Create${agg.name}Response } },`,
  );
  lines.push(`        },`);
  lines.push(`      },`);
  lines.push(`    }),`);
  lines.push(`    async (c) => {`);
  lines.push(`      const body = c.req.valid("json");`);
  lines.push(`      const created = ${agg.name}.create(body as never);`);
  lines.push(`      await repo.save(created);`);
  lines.push(`      return c.json({ id: created.id as string }, 201);`);
  lines.push(`    },`);
  lines.push(`  );`);
  lines.push("");

  // Get by id.
  lines.push(`  app.openapi(`);
  lines.push(`    createRoute({`);
  lines.push(`      method: "get",`);
  lines.push(`      path: "/{id}",`);
  lines.push(`      tags: ["${snake(plural(agg.name))}"],`);
  lines.push(`      operationId: "get${agg.name}ById",`);
  lines.push(`      request: { params: z.object({ id: z.string() }) },`);
  lines.push(`      responses: {`);
  lines.push(
    `        200: { description: "OK", content: { "application/json": { schema: ${agg.name}Response } } },`,
  );
  lines.push(
    `        404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },`,
  );
  lines.push(`      },`);
  lines.push(`    }),`);
  lines.push(`    async (c) => {`);
  lines.push(`      const { id } = c.req.valid("param");`);
  lines.push(`      const found = await repo.findById(Ids.${agg.name}Id(id));`);
  lines.push(
    `      if (!found) return c.json({ error: "not_found" }, 404);`,
  );
  lines.push(`      return c.json({ id: found.id as string }, 200);`);
  lines.push(`    },`);
  lines.push(`  );`);
  lines.push("");

  // Operations.
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(...emitOperationRoute(agg, op).map((l) => `  ${l}`));
    lines.push("");
  }

  // Find queries.
  if (repo) {
    for (const find of repo.finds) {
      lines.push(...emitFindRoute(agg, find).map((l) => `  ${l}`));
      lines.push("");
    }
  }

  // Domain-error handler.
  lines.push(`  app.onError((err, c) => {`);
  lines.push(`    if (err instanceof DomainError) return c.json({ error: err.message }, 400);`);
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message }, 404);`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return c.json({ error: "internal" }, 500);`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function emitOperationRoute(agg: AggregateIR, op: OperationIR): string[] {
  const aggSlug = snake(plural(agg.name));
  const opSnake = snake(op.name);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "post",`);
  out.push(`    path: "/{id}/${opSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camel(op.name)}${agg.name}",`);
  out.push(`    request: {`);
  out.push(`      params: z.object({ id: z.string() }),`);
  out.push(
    `      body: { content: { "application/json": { schema: ${cap(op.name)}Request } } },`,
  );
  out.push(`    },`);
  out.push(`    responses: {`);
  out.push(`      204: { description: "No content" },`);
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const { id } = c.req.valid("param");`);
  out.push(`    const body = c.req.valid("json");`);
  out.push(`    const aggregate = await repo.getById(Ids.${agg.name}Id(id));`);
  const callArgs = op.params.map((p) => `body.${p.name} as never`).join(", ");
  out.push(`    aggregate.${camel(op.name)}(${callArgs});`);
  out.push(`    await repo.save(aggregate);`);
  out.push(`    return c.body(null, 204);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

function emitFindRoute(
  agg: AggregateIR,
  find: import("../../ir/loom-ir.js").FindIR,
): string[] {
  const aggSlug = snake(plural(agg.name));
  const findSnake = snake(find.name);
  const isList = find.returnType.kind === "array";
  const responseSchema = isList ? `${agg.name}ListResponse` : `${agg.name}Response`;
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${findSnake}",`);
  out.push(`    tags: ["${aggSlug}"],`);
  out.push(`    operationId: "${camel(find.name)}",`);
  out.push(`    request: { query: ${cap(find.name)}Query },`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${responseSchema} } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (c) => {`);
  out.push(`    const params = c.req.valid("query");`);
  const argList = find.params.map((p) => `params.${p.name} as never`).join(", ");
  out.push(`    const result = await repo.${find.name}(${argList});`);
  out.push(`    return c.json(result as never, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

// ---------------------------------------------------------------------------
// zod helpers
// ---------------------------------------------------------------------------

function zodFor(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.coerce.number().int()";
        case "decimal":
          return "z.coerce.number()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.coerce.boolean()";
        case "datetime":
          return "z.coerce.date()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `${t.name}Schema`;
    case "valueobject":
      return `${t.name}Schema`;
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodFor(t.element)})`;
    case "optional":
      return `${zodFor(t.inner)}.nullish()`;
  }
}

function collectUsedValueObjects(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): ValueObjectIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const f of repo?.finds ?? []) for (const p of f.params) visit(p.type);
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

function collectUsedEnums(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): EnumIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "enum") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const f of repo?.finds ?? []) for (const p of f.params) visit(p.type);
  return ctx.enums.filter((e) => used.has(e.name));
}

function cap(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
