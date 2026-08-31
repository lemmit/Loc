import { mikroProjectionRowClass } from "../../../generator/typescript/emit/mikroorm.js";
import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import type {
  EnrichedBoundedContextIR,
  ProjectionIR,
  ProjectionOnIR,
  StmtIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isMaterializedProjection } from "../../../ir/types/loom-ir.js";
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { escapeTsIdent, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { zodForResponse } from "./routes-builder.js";

/** The `db` handle's TS type in an emitted projection function signature —
 *  `EntityManager` under the MikroORM adapter (`persistence: mikroorm`), the
 *  Drizzle `NodePgDatabase` otherwise.  Threaded from `buildProjectionsFile`
 *  (mirrors the workflow builder's `wfDbType`). */
const projDbType = (usingMikro: boolean): string =>
  usingMikro ? "EntityManager" : "NodePgDatabase<typeof schema>";

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
 *  Empty string when none (the file is then not written).
 *
 *  `usingMikro` (`persistence: mikroorm`): the read-model store runs on the
 *  MikroORM EntityManager over the generated `<Proj>Row` entities (db/entities.ts)
 *  instead of Drizzle — load/save via `em.findOne`/`em.upsert`, routes via
 *  `em.find`/`em.findOne` (mirrors the workflow builder's `usingMikro` branch). */
export function buildProjectionsFile(ctx: EnrichedBoundedContextIR, usingMikro = false): string {
  // FOLDED (materialized) projections only — the event-folded read model with a
  // physical row table + by-key routes.  Query-time projections
  // (read-path-architecture.md rev.13) have no folds / table and are emitted by
  // `buildQueryProjectionsFile` (http/query-projections.ts) instead.
  const folded = ctx.projections.filter(isMaterializedProjection);
  if (folded.length === 0) return "";

  const body: string[] = [];
  for (const p of folded) body.push(...emitResponseSchemas(p), "");
  for (const p of folded) {
    body.push(...emitStateHelpers(p, usingMikro), "");
    for (const h of p.handlers) body.push(...emitFoldHandler(p, h, usingMikro), "");
  }
  body.push(...emitProjectionTee(folded, usingMikro), "");
  body.push(...emitProjectionRoutes(folded, usingMikro, ctx));
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

  // Persistence-layer imports: the MikroORM store branch reads/upserts the
  // generated `<Proj>Row` entities via the EntityManager (db/entities.ts); the
  // default Drizzle branch selects/inserts the `<Proj>` table (db/schema.ts).
  const persistenceImports = usingMikro
    ? [
        'import { EntityManager } from "@mikro-orm/postgresql";',
        `import { ${folded.map(mikroProjectionRowClass).join(", ")} } from "../db/entities";`,
      ]
    : [
        'import { eq } from "drizzle-orm";',
        'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
        'import * as schema from "../db/schema";',
      ];

  return (
    [
      "// Auto-generated.",
      'import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";',
      ...persistenceImports,
      'import { type DomainEventDispatcher } from "../domain/events";',
      'import type * as Events from "../domain/events";',
      // `ForbiddenError` only when a projection actually declares a `requires`
      // gate — an unused import fails the generated-code Biome gate.
      bodyText.includes("ForbiddenError")
        ? 'import { AggregateNotFoundError, ForbiddenError } from "../domain/errors";'
        : 'import { AggregateNotFoundError } from "../domain/errors";',
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

/** `type <T>State` + load/save helpers over the projection's read-model store
 *  (mirrors `emitWorkflowStateHelpers`).  MikroORM: the correlation Row IS the
 *  state type — load reads by the correlation PK (`findOne`), save upserts on it
 *  (`em.upsert`); the EntityManager owns the schema (`updateSchema` at boot), so
 *  no migration.  Drizzle: the `$inferInsert` row type over the projection table. */
function emitStateHelpers(p: ProjectionIR, usingMikro = false): string[] {
  const T = upperFirst(p.name);
  const corr = p.correlationField;
  const dbType = projDbType(usingMikro);
  if (usingMikro) {
    const rowClass = mikroProjectionRowClass(p);
    return [
      `type ${T}State = ${rowClass};`,
      `async function load${T}(`,
      `  db: ${dbType},`,
      `  key: string,`,
      `): Promise<${T}State | undefined> {`,
      `  const row = await db.findOne(${rowClass}, { ${corr}: key });`,
      `  return row ?? undefined;`,
      `}`,
      `async function save${T}(db: ${dbType}, state: ${T}State): Promise<void> {`,
      `  await db.upsert(${rowClass}, state);`,
      `}`,
    ];
  }
  const table = `schema.${lowerFirst(plural(p.name))}`;
  return [
    `type ${T}State = typeof ${table}.$inferInsert;`,
    `async function load${T}(`,
    `  db: ${dbType},`,
    `  key: string,`,
    `): Promise<${T}State | undefined> {`,
    `  const rows = await db.select().from(${table}).where(eq(${table}.${corr}, key)).limit(1);`,
    `  return rows[0];`,
    `}`,
    `async function save${T}(db: ${dbType}, state: ${T}State): Promise<void> {`,
    `  await db.insert(${table}).values(state).onConflictDoUpdate({ target: ${table}.${corr}, set: state });`,
    `}`,
  ];
}

/** One pure fold: load-or-allocate the row for the event's key, apply the
 *  assignment folds against `state` (this-props render as `state.<field>`),
 *  upsert. */
function emitFoldHandler(p: ProjectionIR, h: ProjectionOnIR, usingMikro = false): string[] {
  const T = upperFirst(p.name);
  const corr = p.correlationField;
  // Key: the `by <expr>` extractor, else the event field name-matching the key.
  const keyExpr = h.correlation
    ? renderTsExpr(h.correlation, { thisName: "state" })
    : `${h.param}.${corr}`;
  // Allocate for a not-yet-seen key: just the correlation column (every other
  // read-model column is nullable, so a partial row is valid — the fold
  // assignments below populate the carried fields before the upsert).  Under
  // MikroORM the state type is the `<Proj>Row` class (definite-assignment
  // fields), so a bare `{ corr }` literal doesn't satisfy it — seed a fresh
  // UNMANAGED instance via `Object.assign` (typed `Row & { corr }` → `Row`, no
  // cast; unmanaged, so no identity-map entry until the upsert).  Drizzle's
  // `$inferInsert` makes nullable columns optional and accepts the bare literal.
  const allocate = usingMikro
    ? `Object.assign(new ${mikroProjectionRowClass(p)}(), { ${corr}: __key })`
    : `{ ${corr}: __key }`;
  const out = [
    `export async function fold${h.event}Into${T}(`,
    `  db: ${projDbType(usingMikro)},`,
    `  ${h.param}: Events.${h.event},`,
    `): Promise<void> {`,
    `  const __key = ${keyExpr};`,
    `  const state = (await load${T}(db, __key)) ?? ${allocate};`,
  ];
  for (const stmt of h.statements) out.push(renderFoldStatement(stmt, p, h));
  out.push(`  await save${T}(db, state);`);
  out.push(`}`);
  return out;
}

/** Render ONE fold-body statement against the `state` row.
 *
 *  This loop used to be `if (stmt.kind === "assign")` with no else, so every
 *  other statement kind a fold body can carry vanished from the emitted
 *  handler — a `let` binding disappeared while its USES survived (TS2304 on
 *  the reference), and `+=` / `-=` / a resource call were dropped outright
 *  with no diagnostic and no compile error, so the column was simply never
 *  written.  The set is now exhaustive over `StmtIR`: the four kinds a pure
 *  fold can express are rendered, and everything else is an internal
 *  invariant violation because `checkProjections`
 *  (`src/ir/validate/checks/projection-checks.ts`) rejects it as impure.
 *  Mirrors the elixir applier's `renderFoldStatement`
 *  (`generator/elixir/vanilla/fold-stmt-emit.ts:54`), including the loud
 *  `default:` — a dropped statement is worse than a crash, because it ships. */
function renderFoldStatement(stmt: StmtIR, p: ProjectionIR, h: ProjectionOnIR): string {
  const ctx = { thisName: "state" } as const;
  switch (stmt.kind) {
    case "assign": {
      const field = lastSegment(stmt.target);
      return `  state.${field} = ${renderTsExpr(stmt.value, ctx)};`;
    }
    case "let":
      // `let`-names may collide with a JS reserved word; escape consistently
      // with the matching `refKind: "let"` use sites in `renderRef`.
      return `  const ${escapeTsIdent(stmt.name)} = ${renderTsExpr(stmt.expr, ctx)};`;
    case "add": {
      // `xs += v` appends to the folded collection; a scalar `n += v`
      // (`collection: false`) is arithmetic on the folded column.  Every
      // non-key read-model column is NULLABLE (the allocate seeds the key
      // only), so both forms coalesce the current value first — otherwise the
      // first event for a key reads `null` and the fold produces `null` /
      // `NaN` instead of the first increment.
      const field = lastSegment(stmt.target);
      const value = renderTsExpr(stmt.value, ctx);
      return stmt.collection
        ? `  state.${field} = [...(state.${field} ?? []), ${value}];`
        : `  state.${field} = (state.${field} ?? 0) + ${value};`;
    }
    case "remove": {
      // `xs -= v` drops the matching element; scalar `n -= v` subtracts.
      const field = lastSegment(stmt.target);
      const value = renderTsExpr(stmt.value, ctx);
      return stmt.collection
        ? `  state.${field} = (state.${field} ?? []).filter((__e) => __e !== ${value});`
        : `  state.${field} = (state.${field} ?? 0) - ${value};`;
    }
    default:
      throw new Error(
        `hono projection fold: unsupported fold statement '${stmt.kind}' in ` +
          `projection '${p.name}' on(${h.param}: ${h.event}) — a fold applies pure ` +
          `assignments / collection mutations / let bindings only; ` +
          `'loom.projection-fold-impure' should have rejected this.`,
      );
  }
}

/** The written column of a fold assignment target (`this`-rooted path). */
function lastSegment(target: { segments: string[] }): string {
  return target.segments[target.segments.length - 1] ?? "";
}

/** The dispatcher decorator: route each dispatched event to every matching
 *  projection fold, then delegate to the inner dispatcher (workflow saga /
 *  realtime / noop).  Composes without touching the workflow dispatcher. */
function emitProjectionTee(projections: ProjectionIR[], usingMikro = false): string[] {
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
    `  db: ${projDbType(usingMikro)},`,
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

/** The `requires` gate lines for one folded projection's read route: bind the
 *  request principal (only when the predicate reads it) then 403 before the
 *  query — the same contract the query-time projection routes emit, and the
 *  reason a folded projection may now carry a gate at all. */
function gateLines(p: ProjectionIR, pad: string): string[] {
  const gate = p.query?.requires;
  if (!gate) return [];
  const out: string[] = [];
  if (exprUsesCurrentUser(gate)) {
    out.push(
      `${pad}const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  out.push(
    `${pad}if (!(${renderTsExpr(gate)})) throw new ForbiddenError(${JSON.stringify(
      `Forbidden: projection ${p.name}`,
    )});`,
  );
  return out;
}

/** The read routes — GET /<snake> (list) + /<snake>/{key} (by correlation id).
 *  Mounted under `/api/projections` by createApp. */
function emitProjectionRoutes(
  projections: ProjectionIR[],
  usingMikro: boolean,
  ctx: EnrichedBoundedContextIR,
): string[] {
  const forbiddenStatus = resolveErrorStatus("Forbidden", ctx.structuralErrorStatuses);
  // RS-27: a projection row read by its correlation KEY is a by-id read, so its
  // absence is the domain `NotFound` rung and follows a `httpStatus NotFound ->
  // <code>` override — declaration and `onError` arm off the same resolved value.
  const notFoundStatus = resolveErrorStatus("NotFound", ctx.structuralErrorStatuses);
  const anyGate = projections.some((p) => p.query?.requires);
  const out = [
    `export function projectionsRoutes(db: ${projDbType(usingMikro)}): OpenAPIHono {`,
    `  const app = new OpenAPIHono();`,
    "",
  ];
  for (const p of projections) {
    const T = upperFirst(p.name);
    const slug = snake(p.name);
    const table = `schema.${lowerFirst(plural(p.name))}`;
    const rowClass = mikroProjectionRowClass(p);
    const corr = p.correlationField;
    const gated = !!p.query?.requires;
    const forbiddenResponse = `        ${forbiddenStatus}: { description: ${JSON.stringify(
      problemTitle(forbiddenStatus),
    )}, content: { "application/problem+json": { schema: ProblemDetails } } },`;
    // List.
    out.push(`  app.openapi(`);
    out.push(`    createRoute({`);
    out.push(`      method: "get",`);
    out.push(`      path: "/${slug}",`);
    out.push(`      tags: ["projections"],`);
    out.push(`      operationId: "list${T}",`);
    // Single-line when ungated — the shape this route has always had, so an
    // ungated projection stays byte-identical.
    if (gated) {
      out.push(`      responses: {`);
      out.push(
        `        200: { description: "OK", content: { "application/json": { schema: ${T}ListResponse } } },`,
      );
      out.push(forbiddenResponse);
      out.push(`      },`);
    } else {
      out.push(
        `      responses: { 200: { description: "OK", content: { "application/json": { schema: ${T}ListResponse } } } },`,
      );
    }
    out.push(`    }),`);
    out.push(`    async (httpCtx) => {`);
    out.push(...gateLines(p, "      "));
    out.push(
      usingMikro
        ? `      const rows = await db.find(${rowClass}, {});`
        : `      const rows = await db.select().from(${table});`,
    );
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
    if (gated) out.push(forbiddenResponse);
    out.push(
      `        ${notFoundStatus}: { description: ${JSON.stringify(
        problemTitle(notFoundStatus),
      )}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
    out.push(`      },`);
    out.push(`    }),`);
    out.push(`    async (httpCtx) => {`);
    out.push(`      const { key } = httpCtx.req.valid("param");`);
    // The gate precedes the read: a caller who fails it must not learn whether
    // the key exists.
    out.push(...gateLines(p, "      "));
    if (usingMikro) {
      out.push(`      const row = await db.findOne(${rowClass}, { ${corr}: key });`);
    } else {
      out.push(
        `      const rows = await db.select().from(${table}).where(eq(${table}.${corr}, key)).limit(1);`,
      );
      out.push(`      const row = rows[0];`);
    }
    // RS-27 extends here — a projection row read by its correlation KEY is a
    // by-id read.
    out.push(`      if (!row) throw new AggregateNotFoundError(\`${T} \${key} not found\`);`);
    out.push(`      return httpCtx.json(row as unknown as z.infer<typeof ${T}Response>, 200);`);
    out.push(`    },`);
    out.push(`  );`);
    out.push("");
  }
  // The router's own error handler.  This sub-app had NONE, which is why the
  // by-key miss above answered `500 Internal Server Error` in `text/plain`:
  // `AggregateNotFoundError` escaped the sub-router, and `app.route()` runs a
  // mounted handler under the SUB-app's error handler — hono's default, not the
  // parent's problem+json one.  Every other emitted router carries this block;
  // this one was serving a 404 as a 500 on node alone (java/python/dotnet/elixir
  // all answer 404), and adding the 403 arm meant adding the handler regardless.
  out.push(`  app.onError((err, c) => {`);
  out.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  out.push(
    `    const problem = (status: ${[...new Set(anyGate ? [forbiddenStatus, notFoundStatus, 500] : [notFoundStatus, 500])].sort((a, b) => a - b).join(" | ")}, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  if (anyGate) {
    out.push(
      `    if (err instanceof ForbiddenError) return problem(${forbiddenStatus}, ${JSON.stringify(
        problemTitle(forbiddenStatus),
      )}, err.message);`,
    );
  }
  out.push(
    `    if (err instanceof AggregateNotFoundError) return problem(${notFoundStatus}, ${JSON.stringify(
      problemTitle(notFoundStatus),
    )}, err.message);`,
  );
  // Same tail as the query-projection router: an unexpected fault is logged and
  // answered as problem+json, never as hono's text/plain default.
  out.push(`    console.error(err);`);
  out.push(`    return problem(500, "Internal Server Error", "internal");`);
  out.push(`  });`);
  out.push("");
  out.push(`  return app;`);
  out.push(`}`);
  return out;
}
