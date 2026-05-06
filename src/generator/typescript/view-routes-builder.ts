import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TypeIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";
import { renderTsExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Hono view routes emission.
//
// For each `view` declared in the context, emit a `GET /<snake>`
// route whose body delegates to the source aggregate's repository
// and projects results to either:
//
//   - the aggregate's existing wire shape via `repo.toWire`
//     (shorthand form `view X = Y where ...`), or
//   - a custom record shape declared in the view's full-form body
//     `view X { fields ... bind ... }`.
//
// One file per context — `http/views.ts` — mounted under `/views`
// in `http/index.ts`.  Matches the workflow / aggregate route
// pattern: typed Zod schemas, OpenAPI annotations, on-error filter.
// ---------------------------------------------------------------------------

const cap = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);

export function buildViewsRoutesFile(
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string {
  if (ctx.views.length === 0) return "";
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError } from "../domain/errors.js";`,
  );
  lines.push(
    `import { type DomainEventDispatcher } from "../domain/events.js";`,
  );
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  lines.push(`import type * as schema from "../db/schema.js";`);
  // Source aggregates + repo imports per view, plus any foreign
  // aggregates referenced via `Id<X>` follow auxiliaries (slice 3).
  const aggsTouched = new Set<string>();
  for (const v of ctx.views) {
    aggsTouched.add(v.aggregateName);
    if (v.output) {
      for (const aux of v.output.auxiliaries) aggsTouched.add(aux.aggName);
    }
  }
  // Source aggregates need the response schema (for shorthand-view
  // routes); foreign aggregates only referenced by follows don't,
  // but importing them is harmless under strict tsc since the file
  // uses them in projection paths.  Track which aggregates are
  // sources to avoid emitting Response imports for follow-only
  // aggregates that may not have aggregates routes if they have no
  // operations / finds — defensive.
  const sourceAggs = new Set(ctx.views.map((v) => v.aggregateName));
  for (const aggName of aggsTouched) {
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${camel(aggName)}-repository.js";`,
    );
    if (sourceAggs.has(aggName)) {
      lines.push(
        `import { ${aggName}Response, ${aggName}ListResponse } from "./${camel(aggName)}.routes.js";`,
      );
    }
  }
  // Value object + enum imports — full-form views may bind to enum
  // values (`status`) or value-object fields.
  const vos = ctx.valueObjects.map((v) => v.name);
  const enums = ctx.enums.map((e) => e.name);
  if (vos.length + enums.length > 0) {
    lines.push(
      `import { ${[...vos, ...enums].join(", ")} } from "../domain/value-objects.js";`,
    );
  }
  lines.push("");

  // Per-full-form-view response Zod schema.  Shorthand views reuse
  // the aggregate's `<Agg>ListResponse` import.
  const enumValues = new Map(ctx.enums.map((e) => [e.name, e.values] as const));
  for (const view of ctx.views) {
    if (!view.output) continue;
    lines.push(`const ${cap(view.name)}Row = z.object({`);
    for (const f of view.output.fields) {
      lines.push(`  ${f.name}: ${zodForRow(f.type, enumValues)},`);
    }
    lines.push(`}).openapi("${cap(view.name)}Row");`);
    lines.push(
      `const ${cap(view.name)}Response = z.array(${cap(view.name)}Row).openapi("${cap(view.name)}Response");`,
    );
  }
  if (ctx.views.some((v) => v.output)) lines.push("");

  lines.push(
    `export function viewsRoutes(`,
  );
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  events: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  lines.push(`  const app = new OpenAPIHono();`);
  lines.push("");

  for (const view of ctx.views) {
    lines.push(...emitViewRoute(view, ctx, aggsByName).map((l) => `  ${l}`));
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    if (err instanceof DomainError) return c.json({ error: err.message }, 400);`,
  );
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

function emitViewRoute(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string[] {
  void ctx;
  void aggsByName;
  const out: string[] = [];
  const aggSlug = snake(plural(view.aggregateName));
  const responseSchema = view.output
    ? `${cap(view.name)}Response`
    : `${view.aggregateName}ListResponse`;
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(view.name)}",`);
  out.push(`    tags: ["views", "${aggSlug}"],`);
  out.push(`    operationId: "${camel(view.name)}View",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${responseSchema} } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  out.push(`    const repo = new ${view.aggregateName}Repository(db, events);`);
  out.push(`    const rows = await repo.${camel(view.name)}();`);
  if (view.output) {
    // Slice 3: bulk-load every foreign aggregate referenced by the
    // bind expressions via `Id<X>` follow.  Each auxiliary becomes
    // a `<Aux>ById` Map keyed by the aggregate's id; the bind
    // renderer rewrites `r.customerId.name` → `customerById.get(
    // r.customerId)!.name`.
    const auxMaps = new Map<string, string>(); // sourceField -> mapVar
    for (const aux of view.output.auxiliaries) {
      const repoVar = `${camel(aux.aggName)}Repo`;
      const mapVar = `${camel(aux.aggName)}ById`;
      out.push(
        `    const ${repoVar} = new ${aux.aggName}Repository(db, events);`,
      );
      out.push(
        `    const ${mapVar} = new Map((await ${repoVar}.findManyByIds(rows.map((r) => r.${aux.sourceField}))).map((__a) => [__a.id as string, __a]));`,
      );
      auxMaps.set(aux.sourceField, mapVar);
    }
    const projectedFields = view.output.binds
      .map(
        (b) =>
          `      ${b.name}: ${renderBindWithFollows(b.expr, "r", auxMaps)}`,
      )
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(
      `    return httpCtx.json(projected as z.infer<typeof ${cap(view.name)}Response>, 200);`,
    );
  } else {
    out.push(
      `    return httpCtx.json(rows.map((r) => repo.toWire(r)) as z.infer<typeof ${view.aggregateName}Response>[], 200);`,
    );
  }
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** Render a view bind expression with `Id<X>` follow rewriting.
 *  Single-hop only: a `member` access whose receiver is a `ref` of
 *  type `kind: "id"` becomes `<auxMap>.get(<thisName>.<sourceField>)!.<member>`.
 *  All other expression shapes delegate to the standard
 *  `renderTsExpr(expr, { thisName })` so the full expression
 *  language stays available for non-follow projections. */
function renderBindWithFollows(
  expr: ExprIR,
  thisName: string,
  auxMaps: Map<string, string>,
): string {
  if (
    expr.kind === "member" &&
    expr.receiver.kind === "ref" &&
    expr.receiver.type?.kind === "id"
  ) {
    const sourceField = expr.receiver.name;
    const mapVar = auxMaps.get(sourceField);
    if (mapVar) {
      return `${mapVar}.get(${thisName}.${sourceField} as string)!.${expr.member}`;
    }
  }
  return renderTsExpr(expr, { thisName });
}

/** Zod schema for a view-output field's TS type.  Decimals stay as
 *  `z.number()`, ids emit as `z.string()`, enum values are emitted
 *  inline as a string-literal union pulled from `enumValues`. */
function zodForRow(t: TypeIR, enumValues: Map<string, string[]>): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum": {
      const values = enumValues.get(t.name) ?? [];
      const lits = values.map((v) => `"${v}"`).join(", ");
      return values.length > 0 ? `z.enum([${lits}])` : "z.string()";
    }
    case "valueobject":
      return "z.unknown()";
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodForRow(t.element, enumValues)})`;
    case "optional":
      return `${zodForRow(t.inner, enumValues)}.nullish()`;
  }
}
