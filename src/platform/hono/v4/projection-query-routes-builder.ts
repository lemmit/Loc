import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import { lowerToDrizzle } from "../../../generator/typescript/repository-find-predicate.js";
import type {
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import {
  isQueryTimeProjection,
  queryProjectionUsesCurrentUser,
} from "../../../ir/types/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono query-time projection routes emission (read-path-architecture.md
// rev.13, § "projection generalises").
//
// A QUERY-TIME projection (`from <Agg> [as a] where … join … select …`, no
// `on(e)` folds) is the always-current read model of the query-time projection
// read.  It reads live — the repository synthesises
// a parameterless `repo.<projName>()` find from the projection's `where`
// (repository-builder.ts), the route bulk-loads every `join` follow
// (`query.auxiliaries`) through the followed aggregate's repository, and
// projects each row through the `select` expressions (rewriting `X id` follows
// to the loaded-alias map).
//
// One file per context — `http/projections.ts` — mounted under `/projections`
// in `http/index.ts` (the folded projection
// read model keeps its own by-key route elsewhere).  Only backends that have
// ported this emit are permitted a query-time projection by the IR validator
// (`loom.projection-query-time-unsupported`); node is the first.
// ---------------------------------------------------------------------------

export function buildQueryProjectionsFile(ctx: EnrichedBoundedContextIR): string {
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  if (projections.length === 0) return "";

  const enumValues = new Map(ctx.enums.map((e) => [e.name, e.values] as const));

  // Foreign aggregates touched: the query source (for its repo + Response) and
  // every `join` follow target (for its repo).  A WORKFLOW source reads the
  // saga-state table directly, and a PROJECTION source reads the folded
  // `<Proj>Row` read-model table directly — both without a repository, so
  // neither contributes here.
  const sourceAggs = new Set<string>();
  const followAggs = new Set<string>();
  const isRawTableSource = (kind?: string) => kind === "workflow" || kind === "projection";
  for (const p of projections) {
    if (p.query?.source && !isRawTableSource(p.query.sourceKind)) sourceAggs.add(p.query.source);
    for (const aux of p.query?.auxiliaries ?? []) followAggs.add(aux.aggName);
  }
  // Pre-compute each raw-table-sourced projection's read (table + Drizzle
  // `where`) — a WORKFLOW source reads its persisted saga-state table, a
  // PROJECTION source reads the SOURCE projection's folded `<Proj>Row` read-model
  // table (named `schema.<lowerFirst(plural(source))>`, exactly as the folded
  // projection emitter in projection-builder.ts creates it).  Accumulate the
  // Drizzle operators the filter needs so the import line below can list them.
  // `lowerToDrizzle` takes the BARE table name and prepends `schema.` on the
  // column refs itself.
  const rawDrizzleOps = new Set<string>();
  const rawReads = new Map<string, { table: string; where?: string }>();
  for (const p of projections) {
    if (!isRawTableSource(p.query?.sourceKind) || !p.query?.source) continue;
    const tableBare = lowerFirst(plural(p.query.source));
    let where: string | undefined;
    if (p.query.filter) {
      const lowered = lowerToDrizzle(p.query.filter, tableBare, ctx);
      if (lowered) {
        where = lowered.expr;
        for (const op of lowered.ops) rawDrizzleOps.add(op);
      }
    }
    rawReads.set(p.name, { table: `schema.${tableBare}`, where });
  }
  const allAggs = new Set([...sourceAggs, ...followAggs]);
  const usesEvents =
    projections.some((p) => (p.query?.auxiliaries.length ?? 0) > 0) || sourceAggs.size > 0;
  const needsIds = projections.some((p) =>
    (p.query?.auxiliaries ?? []).some((a) => a.path.length >= 1),
  );

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { newApp } from "./problem-details";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  lines.push(`import type * as schema from "../db/schema";`);
  if (rawDrizzleOps.size > 0) {
    lines.push(`import { ${[...rawDrizzleOps].sort().join(", ")} } from "drizzle-orm";`);
  }
  if (needsIds) lines.push(`import * as Ids from "../domain/ids";`);
  for (const aggName of [...allAggs].sort()) {
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${lowerFirst(aggName)}-repository";`,
    );
  }
  const vos = ctx.valueObjects.map((v) => v.name);
  const enums = ctx.enums.map((e) => e.name);
  if (vos.length + enums.length > 0) {
    lines.push(`import { ${[...vos, ...enums].join(", ")} } from "../domain/value-objects";`);
  }
  lines.push("");

  // Per-projection row / response schema (the declared `<Proj>Row` shape).
  for (const p of projections) {
    const T = upperFirst(p.name);
    lines.push(`const ${T}Row = z.object({`);
    for (const f of p.wireShape ?? []) {
      lines.push(
        `  ${f.name}: ${f.source === "id" ? "z.string()" : zodForRow(f.type, enumValues)},`,
      );
    }
    lines.push(`}).openapi("${T}Row");`);
    lines.push(`const ${T}Response = z.array(${T}Row).openapi("${T}Response");`);
  }
  lines.push("");

  lines.push(`export function queryProjectionsRoutes(`);
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  ${usesEvents ? "events" : "_events"}: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  lines.push(`  const app = newApp();`);
  lines.push("");

  for (const p of projections) {
    lines.push(...emitQueryProjectionRoute(p, rawReads.get(p.name)).map((l) => `  ${l}`));
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  lines.push(
    `    const problem = (status: 400 | 403 | 404 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(
    `    if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);`,
  );
  lines.push(
    `    if (err instanceof DomainError) return problem(400, "Bad Request", err.message);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);`,
  );
  lines.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", err.message); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return `${lines.join("\n")}\n`;
}

/** One query-time projection route: `GET /<projName>` under `/projections`.
 *  Sources filtered aggregate rows via the synthesised `repo.<projName>()`
 *  find, bulk-loads each `join` follow, then projects each row through the
 *  `select` expressions — the query-time projection read, parameterised by the
 *  projection's own row shape. */
function emitQueryProjectionRoute(
  p: ProjectionIR,
  rawRead?: { table: string; where?: string },
): string[] {
  const T = upperFirst(p.name);
  const source = p.query!.source!;
  const aggSlug = snake(plural(source));
  const usesUser = queryProjectionUsesCurrentUser(p);
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(p.name)}",`);
  out.push(`    tags: ["projections", "${aggSlug}"],`);
  out.push(`    operationId: "projection${T}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${T}Response } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  const gate = p.query!.requires;
  out.push(`  async (httpCtx) => {`);
  // The `requires` gate (and any currentUser-scoped filter) needs the request
  // principal in scope; a failing gate denies with 403 (ForbiddenError → 403)
  // BEFORE the query runs.
  if (usesUser || gate) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  if (gate) {
    out.push(`    if (!(${renderTsExpr(gate)})) throw new ForbiddenError("Forbidden");`);
  }
  // alias → { mapVar, idRow } — the loaded-map var and the source-row expression
  // that yields this alias's key (the join's `on <idRef>`, rendered off `r`).
  const aliasMap = new Map<string, { mapVar: string; idRow: string }>();
  if (rawRead) {
    // RAW-TABLE source (WORKFLOW saga-state table or a folded PROJECTION's
    // `<Proj>Row` read-model table): read the table directly (no repository, no
    // `join` follows — validator-gated), applying the `where` in SQL.  The
    // `select` projection below reads the source row fields off each row exactly
    // like an aggregate candidate.
    out.push(
      `    const rows = await db.select().from(${rawRead.table})${rawRead.where ? `.where(${rawRead.where})` : ""};`,
    );
    const projectedFields = (p.query!.selects ?? [])
      .map((s) => `      ${s.field}: ${renderProjectionSelect(s.expr, aliasMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  out.push(`    const repo = new ${source}Repository(db, events);`);
  out.push(`    const rows = await repo.${lowerFirst(p.name)}(${usesUser ? "currentUser" : ""});`);
  // Bulk-load every `join` follow (dependency-ordered), then project.  Each
  // join binds an ALIAS (`c`) to the loaded-by-id map; a `select` reads through
  // that alias (`c.name`), rewritten to `<mapVar>.get(<idRowExpr> as string)!`.
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  const joins = p.query!.joins;
  const auxes = p.query!.auxiliaries;
  for (let i = 0; i < auxes.length; i++) {
    const aux = auxes[i]!;
    const join = joins[i];
    const repoVar = `${lowerFirst(aux.aggName)}Repo`;
    out.push(`    const ${repoVar} = new ${aux.aggName}Repository(db, events);`);
    const idsSource = idsSourceForAux(aux, pathToMap);
    out.push(
      `    const ${aux.mapVar} = new Map((await ${repoVar}.findManyByIds(${idsSource})).map((a) => [a.id as string, a]));`,
    );
    pathToMap.set(aux.path.join("."), { mapVar: aux.mapVar, aggName: aux.aggName });
    if (join)
      aliasMap.set(join.alias, {
        mapVar: aux.mapVar,
        idRow: renderTsExpr(join.idRef, { thisName: "r" }),
      });
  }
  if ((p.query!.selects?.length ?? 0) === 0) {
    // SHORTHAND (no `select`): the row IS the source aggregate's wire shape, so
    // serialise each source row through the repository's `toWire` (the same
    // projection the aggregate's own read routes use) — no per-field mapping.
    out.push(`    const projected = rows.map((r) => repo.toWire(r));`);
  } else {
    const projectedFields = (p.query!.selects ?? [])
      .map((s) => `      ${s.field}: ${renderProjectionSelect(s.expr, aliasMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
  }
  out.push(`    return httpCtx.json(projected as z.infer<typeof ${T}Response>, 200);`);
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** Render a `select` expression against the source row `r` and the join alias
 *  maps.  A member access on a join alias (`c.name`, where `c` is a `join
 *  Customer as c on <idRef>`) rewrites to `<mapVar>.get(<idRow> as string)!.name`
 *  — the loaded-by-id aggregate for that row.  Source-candidate reads (`o.id`,
 *  bare `lineCount`) lower to `this`/row refs and render off `r` unchanged. */
function renderProjectionSelect(
  expr: ExprIR,
  aliasMap: Map<string, { mapVar: string; idRow: string }>,
): string {
  if (expr.kind === "member" && expr.receiver.kind === "ref") {
    const alias = aliasMap.get(expr.receiver.name);
    if (alias) return `${alias.mapVar}.get(${alias.idRow} as string)!.${expr.member}`;
  }
  return renderTsExpr(expr, { thisName: "r" });
}

/** Pick the id-source expression for an auxiliary's bulk load.
 *  Length-1 paths source from the row var (`rows.map(r => r.<f>)`);
 *  length-2+ paths source from the prior map (the auxiliary whose
 *  path is the current path's prefix).
 *
 *  `fromRow` distinguishes the projection source: a `<Proj>Row` read-model
 *  column is nullable `string | null` (not the aggregate's non-nullable branded
 *  `<Agg>Id`), so a first-hop follow off a projection row drops NULLs and
 *  re-brands each value with `Ids.<Agg>Id(...)` before `findManyByIds`.  Later
 *  hops read hydrated aggregates and already hold proper id types. */
export function idsSourceForAux(
  aux: { path: string[]; aggName: string; mapVar: string },
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
  fromRow = false,
): string {
  if (aux.path.length === 1) {
    if (fromRow) {
      return `rows.map((r) => r.${aux.path[0]!}).filter((x): x is string => x !== null).map((x) => Ids.${aux.aggName}Id(x))`;
    }
    return `rows.map((r) => r.${aux.path[0]!})`;
  }
  const prevPath = aux.path.slice(0, -1).join(".");
  const prev = pathToMap.get(prevPath);
  if (!prev) return `[]`;
  const finalField = aux.path[aux.path.length - 1]!;
  return `[...${prev.mapVar}.values()].map((a) => a.${finalField})`;
}

/** Zod schema for a projection-output field's TS type.  Decimals stay as
 *  `z.number()`, ids emit as `z.string()`, enum values are emitted
 *  inline as a string-literal union pulled from `enumValues`. */
export function zodForRow(t: TypeIR, enumValues: Map<string, string[]>): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "money":
          return "z.string()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
        case "json":
          return "z.unknown()";
        case "File":
          return "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })";
        case "duration":
          // A5: expression-only primitive — never a projection-row / wire type.
          throw new Error("internal: 'duration' is expression-only and never reaches a view row");
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
    case "action":
    case "slot":
      throw new Error("zodForRow: 'slot' type is UI-only and should not reach a view-row schema.");
    case "genericInstance":
      throw new Error(
        `zodForRow: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `zodForRow: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}
