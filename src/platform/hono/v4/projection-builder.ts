import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import type {
  EnrichedBoundedContextIR,
  ProjectionIR,
  ProjectionOnIR,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { zodForResponse } from "./routes-builder.js";

// ---------------------------------------------------------------------------
// Hono projection emission (projection.md) — `http/projections.ts`.
//
// A projection is the passive read-half of an event-sourced workflow, so this
// mirrors the workflow saga runtime (`workflow-builder.ts`) with the command
// side removed:
//   - one pure FOLD handler per (projection, event): load-or-allocate the row
//     keyed by the correlation column, apply the fold assignments against a
//     `state` object, upsert.  Every handler allocates (a projection has no
//     route-or-drop split — the first event for a key creates the row).
//   - `projectionTee(db, inner)` — a dispatcher DECORATOR (like `realtimeTee`)
//     that routes each dispatched event to the matching folds, then delegates.
//     Composing rather than modifying the workflow dispatcher keeps saga output
//     byte-identical.
//   - read routes: GET /<snake> (list) + /<snake>/{key} (by correlation id),
//     serialised through the projection `wireShape`.  Mounted under
//     `/api/projections` by `createApp`.
//
// Non-key read-model columns are nullable (a fold upserts a partial row until
// every contributing event arrives), so the allocate literal is just the key.
// ---------------------------------------------------------------------------

/** Emit `http/projections.ts` for a context that declares ≥1 projection.
 *  Empty string when none (the file is then not written). */
export function buildProjectionsFile(ctx: EnrichedBoundedContextIR): string {
  if (ctx.projections.length === 0) return "";

  const body: string[] = [];
  for (const p of ctx.projections) body.push(...emitResponseSchemas(p), "");
  for (const p of ctx.projections) {
    body.push(...emitStateHelpers(p), "");
    for (const h of p.handlers) body.push(...emitFoldHandler(p, h), "");
  }
  body.push(...emitProjectionTee(ctx.projections), "");
  body.push(...emitProjectionRoutes(ctx.projections));
  const bodyText = body.join("\n");

  // Enum zod schemas are inlined (a `<E>Schema` referenced by a response DTO);
  // enum VALUE objects (`<E>.Case` in a fold) are imported from the domain.
  // Both derived by intersecting the ctx enums with the emitted text so the
  // import/decl lines stay free of dead names (the generated-code Biome gate).
  const enumSchemaDecls = ctx.enums
    .filter((e) => bodyText.includes(`${e.name}Schema`))
    .map(
      (e) =>
        `const ${e.name}Schema = z.enum([${e.values.map((v) => `"${v}"`).join(", ")}]).openapi("${e.name}");`,
    );
  const enumValueImports = ctx.enums
    .filter((e) => new RegExp(`\\b${e.name}\\.`).test(bodyText))
    .map((e) => e.name);
  const enumValueImportLine =
    enumValueImports.length > 0
      ? `import { ${enumValueImports.join(", ")} } from "../domain/value-objects";`
      : null;

  return (
    [
      "// Auto-generated.",
      'import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";',
      'import { eq } from "drizzle-orm";',
      'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
      'import * as schema from "../db/schema";',
      'import { type DomainEventDispatcher } from "../domain/events";',
      'import type * as Events from "../domain/events";',
      'import { AggregateNotFoundError } from "../domain/errors";',
      'import { ProblemDetails } from "./problem-details";',
      enumValueImportLine,
      "",
      ...(enumSchemaDecls.length > 0 ? [...enumSchemaDecls, ""] : []),
      bodyText,
    ]
      .filter((l) => l !== null)
      .join("\n") + "\n"
  );
}

/** The response DTO (one row) + its list carrier, over the projection's wire
 *  shape — the correlation field as an id string, then the state properties. */
function emitResponseSchemas(p: ProjectionIR): string[] {
  const T = upperFirst(p.name);
  const out = [`const ${T}Response = z.object({`];
  for (const f of p.wireShape ?? []) {
    if (f.source === "id") out.push(`  ${f.name}: z.string(),`);
    else out.push(`  ${f.name}: ${zodForResponse(f.type, true)},`);
  }
  out.push(`}).openapi("${T}Response");`);
  out.push(`const ${T}ListResponse = z.array(${T}Response).openapi("${T}ListResponse");`);
  return out;
}

/** `type <T>State` + load/save helpers over the projection's Drizzle table
 *  (mirrors `emitWorkflowStateHelpers`). */
function emitStateHelpers(p: ProjectionIR): string[] {
  const T = upperFirst(p.name);
  const table = `schema.${lowerFirst(plural(p.name))}`;
  const corr = p.correlationField;
  return [
    `type ${T}State = typeof ${table}.$inferInsert;`,
    `async function load${T}(`,
    `  db: NodePgDatabase<typeof schema>,`,
    `  key: string,`,
    `): Promise<${T}State | undefined> {`,
    `  const rows = await db.select().from(${table}).where(eq(${table}.${corr}, key)).limit(1);`,
    `  return rows[0];`,
    `}`,
    `async function save${T}(db: NodePgDatabase<typeof schema>, state: ${T}State): Promise<void> {`,
    `  await db.insert(${table}).values(state).onConflictDoUpdate({ target: ${table}.${corr}, set: state });`,
    `}`,
  ];
}

/** One pure fold: load-or-allocate the row for the event's key, apply the
 *  assignment folds against `state` (this-props render as `state.<field>`),
 *  upsert. */
function emitFoldHandler(p: ProjectionIR, h: ProjectionOnIR): string[] {
  const T = upperFirst(p.name);
  const corr = p.correlationField;
  // Key: the `by <expr>` extractor, else the event field name-matching the key.
  const keyExpr = h.correlation
    ? renderTsExpr(h.correlation, { thisName: "state" })
    : `${h.param}.${corr}`;
  const out = [
    `export async function fold${h.event}Into${T}(`,
    `  db: NodePgDatabase<typeof schema>,`,
    `  ${h.param}: Events.${h.event},`,
    `): Promise<void> {`,
    `  const __key = ${keyExpr};`,
    `  const state = (await load${T}(db, __key)) ?? { ${corr}: __key };`,
  ];
  for (const stmt of h.statements) {
    if (stmt.kind === "assign") {
      const segs = stmt.target.segments;
      const field = segs[segs.length - 1];
      out.push(`  state.${field} = ${renderTsExpr(stmt.value, { thisName: "state" })};`);
    }
  }
  out.push(`  await save${T}(db, state);`);
  out.push(`}`);
  return out;
}

/** The dispatcher decorator: route each dispatched event to every matching
 *  projection fold, then delegate to the inner dispatcher (workflow saga /
 *  realtime / noop).  Composes without touching the workflow dispatcher. */
function emitProjectionTee(projections: ProjectionIR[]): string[] {
  // event type → the fold calls it triggers (one per matching handler).
  const byEvent = new Map<string, string[]>();
  for (const p of projections) {
    for (const h of p.handlers) {
      const call = `await fold${h.event}Into${upperFirst(p.name)}(db, event as Events.${h.event});`;
      const calls = byEvent.get(h.event) ?? [];
      calls.push(call);
      byEvent.set(h.event, calls);
    }
  }
  const out = [
    `export function projectionTee(`,
    `  db: NodePgDatabase<typeof schema>,`,
    `  inner: DomainEventDispatcher,`,
    `): DomainEventDispatcher {`,
    `  return {`,
    `    async dispatch(event: Events.DomainEvent): Promise<void> {`,
    `      switch (event.type) {`,
  ];
  for (const [eventType, calls] of byEvent) {
    out.push(`        case ${JSON.stringify(eventType)}:`);
    for (const c of calls) out.push(`          ${c}`);
    out.push(`          break;`);
  }
  out.push(`      }`);
  out.push(`      await inner.dispatch(event);`);
  out.push(`    },`);
  out.push(`  };`);
  out.push(`}`);
  return out;
}

/** The read routes — GET /<snake> (list) + /<snake>/{key} (by correlation id).
 *  Mounted under `/api/projections` by createApp. */
function emitProjectionRoutes(projections: ProjectionIR[]): string[] {
  const out = [
    `export function projectionsRoutes(db: NodePgDatabase<typeof schema>): OpenAPIHono {`,
    `  const app = new OpenAPIHono();`,
    "",
  ];
  for (const p of projections) {
    const T = upperFirst(p.name);
    const slug = snake(p.name);
    const table = `schema.${lowerFirst(plural(p.name))}`;
    const corr = p.correlationField;
    // List.
    out.push(`  app.openapi(`);
    out.push(`    createRoute({`);
    out.push(`      method: "get",`);
    out.push(`      path: "/${slug}",`);
    out.push(`      tags: ["projections"],`);
    out.push(`      operationId: "list${T}",`);
    out.push(
      `      responses: { 200: { description: "OK", content: { "application/json": { schema: ${T}ListResponse } } } },`,
    );
    out.push(`    }),`);
    out.push(`    async (httpCtx) => {`);
    out.push(`      const rows = await db.select().from(${table});`);
    out.push(
      `      return httpCtx.json(rows as unknown as z.infer<typeof ${T}ListResponse>, 200);`,
    );
    out.push(`    },`);
    out.push(`  );`);
    // By key.
    out.push(`  app.openapi(`);
    out.push(`    createRoute({`);
    out.push(`      method: "get",`);
    out.push(`      path: "/${slug}/{key}",`);
    out.push(`      tags: ["projections"],`);
    out.push(`      operationId: "get${T}",`);
    out.push(`      request: { params: z.object({ key: z.string() }) },`);
    out.push(`      responses: {`);
    out.push(
      `        200: { description: "OK", content: { "application/json": { schema: ${T}Response } } },`,
    );
    out.push(
      `        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
    out.push(`      },`);
    out.push(`    }),`);
    out.push(`    async (httpCtx) => {`);
    out.push(`      const { key } = httpCtx.req.valid("param");`);
    out.push(
      `      const rows = await db.select().from(${table}).where(eq(${table}.${corr}, key)).limit(1);`,
    );
    out.push(`      const row = rows[0];`);
    out.push(`      if (!row) throw new AggregateNotFoundError("not_found");`);
    out.push(`      return httpCtx.json(row as unknown as z.infer<typeof ${T}Response>, 200);`);
    out.push(`    },`);
    out.push(`  );`);
    out.push("");
  }
  out.push(`  return app;`);
  out.push(`}`);
  return out;
}
